import pLimit from "p-limit";
import type {
  MeteoraPool,
  PoolScoreBreakdown,
  JupiterAssessment,
  RiskAssessment,
  ScoredPool,
  TokenDexSummary
} from "../types.js";
import { DexScreenerApi } from "../services/DexScreenerApi.js";
import { JupiterTokenApi } from "../services/JupiterTokenApi.js";
import { MeteoraDataApi } from "../services/MeteoraDataApi.js";
import { RugCheckApi } from "../services/RugCheckApi.js";

export interface PoolScannerOptions {
  pageSize: number;
  candidateLimit: number;
  minTvlUsd: number;
  minVolume24hUsd: number;
  requireTokenVerified: boolean;
  allowUnverifiedIfJupiterPasses: boolean;
  sortBy: string;
  discoverySorts: string[];
  discoveryMaxPoolAgeHours: number;
  discoveryMinTvlUsd: number;
  discoveryMinVolume30mUsd: number;
  discoveryMinVolume1hUsd: number;
  discoveryMinFeeTvlRatio30m: number;
  discoveryMinFeeTvlRatio1h: number;
  jupiterHighConfidenceOrganicScore: number;
  concurrency?: number;
}

export class PoolScanner {
  private readonly riskCache = new Map<string, Promise<RiskAssessment>>();
  private readonly dexCache = new Map<string, Promise<TokenDexSummary>>();

  constructor(
    private readonly meteora: MeteoraDataApi,
    private readonly rugCheck: RugCheckApi,
    private readonly jupiter: JupiterTokenApi,
    private readonly dexScreener: DexScreenerApi | null,
    private readonly options: PoolScannerOptions
  ) {}

  async scan(): Promise<ScoredPool[]> {
    const pools = await this.discoverCandidates();
    const limit = pLimit(this.options.concurrency ?? 6);
    const candidates = pools.slice(0, this.options.candidateLimit);
    const scored = await Promise.all(candidates.map((pool) => limit(() => this.scorePool(pool))));

    return scored.sort((a, b) => b.score - a.score);
  }

  private async discoverCandidates(): Promise<MeteoraPool[]> {
    const sorts = [this.options.sortBy, ...this.options.discoverySorts];
    const responses = await Promise.all(
      sorts.map((sortBy) =>
        this.meteora.listPools({
          page: 1,
          pageSize: this.options.pageSize,
          sortBy,
          filterBy: this.buildFilter(sortBy)
        })
      )
    );

    const byAddress = new Map<string, MeteoraPool>();
    for (const response of responses) {
      for (const pool of response.data) {
        byAddress.set(pool.address, pool);
      }
    }

    return [...byAddress.values()];
  }

  private buildFilter(sortBy: string): string {
    if (sortBy === "pool_created_at:desc") {
      return ["is_blacklisted=false", `tvl>=${this.options.discoveryMinTvlUsd}`].join(" && ");
    }

    return [
      "is_blacklisted=false",
      `tvl>=${this.options.minTvlUsd}`,
      `volume_24h>=${this.options.minVolume24hUsd}`
    ].join(" && ");
  }

  private async scorePool(pool: MeteoraPool): Promise<ScoredPool> {
    const risk = await Promise.all([
      this.assessRisk(pool.token_x.address),
      this.assessRisk(pool.token_y.address)
    ]);
    const jupiter = await this.jupiter.assessTokens([pool.token_x.address, pool.token_y.address]);
    const dex = await this.dexSummaries(pool);
    const breakdown = this.scoreBreakdown(pool, risk, jupiter, dex);
    const reasons = this.rejectionReasons(pool, risk, jupiter);
    const score =
      breakdown.shortHorizonFeeScore +
      breakdown.recencyScore +
      breakdown.feeTvlScore +
      breakdown.volumeTvlScore +
      breakdown.tvlScore +
      breakdown.verificationScore +
      breakdown.dexConfirmationScore +
      breakdown.jupiterOrganicScore -
      breakdown.binStepPenalty -
      breakdown.riskPenalty -
      breakdown.jupiterPenalty;

    return {
      pool,
      score,
      eligible: reasons.length === 0,
      reasons,
      risk,
      jupiter,
      dex,
      breakdown
    };
  }

  private assessRisk(mint: string): Promise<RiskAssessment> {
    const cached = this.riskCache.get(mint);
    if (cached) {
      return cached;
    }
    const request = this.rugCheck.assessToken(mint);
    this.riskCache.set(mint, request);
    return request;
  }

  private async dexSummaries(pool: MeteoraPool): Promise<TokenDexSummary[]> {
    if (!this.dexScreener) {
      return [];
    }
    return Promise.all([this.dexSummary(pool.token_x.address), this.dexSummary(pool.token_y.address)]);
  }

  private dexSummary(mint: string): Promise<TokenDexSummary> {
    const cached = this.dexCache.get(mint);
    if (cached) {
      return cached;
    }
    const request = this.dexScreener!.summarizeToken(mint).catch(() => ({
      mint,
      totalLiquidityUsd: 0,
      totalVolume24hUsd: 0,
      pairCount: 0
    }));
    this.dexCache.set(mint, request);
    return request;
  }

  private rejectionReasons(pool: MeteoraPool, risk: RiskAssessment[], jupiter: JupiterAssessment[]): string[] {
    const reasons: string[] = [];
    if (pool.is_blacklisted) {
      reasons.push("Meteora blacklist");
    }
    if (pool.tvl < this.options.discoveryMinTvlUsd) {
      reasons.push(`TVL below discovery floor ${this.options.discoveryMinTvlUsd}`);
    }
    if (!this.hasMatureVolume(pool) && !this.hasDiscoveryMomentum(pool)) {
      reasons.push("Insufficient mature 24h volume or discovery 30m/1h momentum");
    }
    if (
      this.options.requireTokenVerified &&
      (!pool.token_x.is_verified || !pool.token_y.is_verified) &&
      !this.hasHighConfidenceJupiter(jupiter)
    ) {
      reasons.push("Unverified token");
    }
    for (const tokenRisk of risk) {
      if (tokenRisk.isDangerous) {
        reasons.push(`RugCheck ${tokenRisk.mint}: ${tokenRisk.reasons.join(", ")}`);
      }
    }
    for (const tokenTrust of jupiter) {
      if (tokenTrust.isDangerous) {
        reasons.push(`Jupiter ${tokenTrust.mint}: ${tokenTrust.reasons.join(", ")}`);
      }
    }
    return reasons;
  }

  private scoreBreakdown(
    pool: MeteoraPool,
    risk: RiskAssessment[],
    jupiter: JupiterAssessment[],
    dex: TokenDexSummary[]
  ): PoolScoreBreakdown {
    const tvl = Math.max(pool.tvl, 1);
    const volume24h = Math.max(pool.volume["24h"], 0);
    const volume1h = Math.max(pool.volume["1h"], 0);
    const volume30m = Math.max(pool.volume["30m"], 0);
    const fees24h = Math.max(pool.fees["24h"], 0);
    const feeTvlRatio = pool.fee_tvl_ratio["24h"] || (fees24h / tvl) * 100;
    const shortFeeTvlRatio = Math.max(pool.fee_tvl_ratio["30m"] ?? 0, pool.fee_tvl_ratio["1h"] ?? 0);
    const dexLiquidity = dex.reduce((sum, item) => sum + item.totalLiquidityUsd, 0);
    const dexVolume = dex.reduce((sum, item) => sum + item.totalVolume24hUsd, 0);
    const riskPenalty = risk.reduce((sum, item) => {
      const scorePenalty = item.scoreNormalized === null ? 20 : item.scoreNormalized * 0.7;
      return sum + scorePenalty + (item.isDangerous ? 100 : 0);
    }, 0);
    const jupiterPenalty = jupiter.reduce((sum, item) => {
      if (item.organicScore === null) {
        return sum + 35 + (item.isDangerous ? 100 : 0);
      }
      return sum + Math.max(0, 70 - item.organicScore) * 1.2 + (item.isDangerous ? 100 : 0);
    }, 0);
    const jupiterOrganicScore = clamp(
      jupiter.reduce((sum, item) => sum + (item.organicScore ?? 0), 0) / Math.max(jupiter.length, 1),
      0,
      100
    );
    const recent = this.poolAgeHours(pool) <= this.options.discoveryMaxPoolAgeHours;

    return {
      shortHorizonFeeScore: clamp(shortFeeTvlRatio * 5, 0, 120),
      recencyScore: recent && this.hasDiscoveryMomentum(pool) ? 35 : 0,
      feeTvlScore: clamp(feeTvlRatio * 4, 0, 120),
      volumeTvlScore: clamp(Math.log10(1 + Math.max(volume24h, volume1h * 12, volume30m * 24) / tvl) * 35, 0, 90),
      tvlScore: clamp(Math.log10(tvl) * 8, 0, 80),
      verificationScore: pool.token_x.is_verified && pool.token_y.is_verified ? 20 : -25,
      dexConfirmationScore: clamp(Math.log10(1 + dexLiquidity) * 1.4 + Math.log10(1 + dexVolume) * 1.1, 0, 25),
      jupiterOrganicScore,
      binStepPenalty: clamp(pool.pool_config.bin_step / 4, 0, 25),
      riskPenalty,
      jupiterPenalty
    };
  }

  private hasMatureVolume(pool: MeteoraPool): boolean {
    return pool.tvl >= this.options.minTvlUsd && pool.volume["24h"] >= this.options.minVolume24hUsd;
  }

  private hasDiscoveryMomentum(pool: MeteoraPool): boolean {
    const ageHours = this.poolAgeHours(pool);
    if (ageHours > this.options.discoveryMaxPoolAgeHours || pool.tvl < this.options.discoveryMinTvlUsd) {
      return false;
    }
    const volumeOk =
      pool.volume["30m"] >= this.options.discoveryMinVolume30mUsd ||
      pool.volume["1h"] >= this.options.discoveryMinVolume1hUsd;
    const feeOk =
      pool.fee_tvl_ratio["30m"] >= this.options.discoveryMinFeeTvlRatio30m ||
      pool.fee_tvl_ratio["1h"] >= this.options.discoveryMinFeeTvlRatio1h;
    return volumeOk && feeOk;
  }

  private hasHighConfidenceJupiter(jupiter: JupiterAssessment[]): boolean {
    if (!this.options.allowUnverifiedIfJupiterPasses) {
      return false;
    }
    return jupiter.every(
      (item) =>
        !item.isDangerous &&
        item.organicScore !== null &&
        item.organicScore >= this.options.jupiterHighConfidenceOrganicScore
    );
  }

  private poolAgeHours(pool: MeteoraPool): number {
    return Math.max(0, (Date.now() - pool.created_at) / 3_600_000);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
