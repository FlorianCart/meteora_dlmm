import {
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
  type JupiterAssessment,
  type JupiterTokenInfo
} from "../types.js";
import { HttpClient } from "./HttpClient.js";

export interface JupiterTokenSafetyOptions {
  enabled: boolean;
  failClosed: boolean;
  minOrganicScore: number;
  highConfidenceOrganicScore: number;
  minLiquidityUsd: number;
  minHolderCount: number;
  maxTopHoldersPct: number;
  maxDevBalancePct: number;
  requireMintAuthorityDisabled: boolean;
  requireFreezeAuthorityDisabled: boolean;
}

const TRUSTED_SYSTEM_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

export class JupiterTokenApi {
  private readonly cache = new Map<string, Promise<JupiterAssessment>>();

  constructor(
    private readonly http: HttpClient,
    private readonly options: JupiterTokenSafetyOptions
  ) {}

  assessToken(mint: string): Promise<JupiterAssessment> {
    if (!this.options.enabled) {
      return Promise.resolve({
        mint,
        found: false,
        isDangerous: false,
        isVerified: null,
        organicScore: null,
        organicScoreLabel: null,
        liquidityUsd: null,
        holderCount: null,
        topHoldersPercentage: null,
        organicVolume1hUsd: 0,
        organicBuyers1h: 0,
        reasons: ["Jupiter disabled"]
      });
    }

    const cached = this.cache.get(mint);
    if (cached) {
      return cached;
    }

    const request = this.fetchToken(mint)
      .then((token) => this.toAssessment(mint, token))
      .catch((error) => this.unavailableAssessment(mint, error));
    this.cache.set(mint, request);
    return request;
  }

  async assessTokens(mints: string[]): Promise<JupiterAssessment[]> {
    return Promise.all(mints.map((mint) => this.assessToken(mint)));
  }

  private async fetchToken(mint: string): Promise<JupiterTokenInfo | null> {
    const response = await this.http.getJson<JupiterTokenInfo[]>("/search", {
      query: { query: mint }
    });
    return response.find((token) => token.id === mint) ?? null;
  }

  private unavailableAssessment(mint: string, error: unknown): JupiterAssessment {
    if (TRUSTED_SYSTEM_MINTS.has(mint)) {
      return {
        mint,
        found: false,
        isDangerous: false,
        isVerified: true,
        organicScore: 100,
        organicScoreLabel: "trusted",
        liquidityUsd: null,
        holderCount: null,
        topHoldersPercentage: null,
        organicVolume1hUsd: 0,
        organicBuyers1h: 0,
        reasons: ["Trusted system mint; Jupiter unavailable ignored"]
      };
    }

    return {
      mint,
      found: false,
      isDangerous: this.options.failClosed,
      isVerified: null,
      organicScore: null,
      organicScoreLabel: null,
      liquidityUsd: null,
      holderCount: null,
      topHoldersPercentage: null,
      organicVolume1hUsd: 0,
      organicBuyers1h: 0,
      reasons: [`Jupiter unavailable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  private toAssessment(mint: string, token: JupiterTokenInfo | null): JupiterAssessment {
    if (!token) {
      return this.unavailableAssessment(mint, new Error("Token not found"));
    }

    const audit = token.audit ?? {};
    const organicScore = token.organicScore ?? null;
    const organicScoreLabel = token.organicScoreLabel ?? null;
    const liquidityUsd = token.liquidity ?? null;
    const holderCount = token.holderCount ?? null;
    const topHoldersPercentage = audit.topHoldersPercentage ?? null;
    const organicVolume1hUsd = organicVolume(token.stats1h);
    const organicBuyers1h = token.stats1h?.numOrganicBuyers ?? 0;
    const reasons: string[] = [];
    const trusted = TRUSTED_SYSTEM_MINTS.has(mint);

    if ("isSus" in audit) {
      reasons.push("Jupiter audit.isSus present");
    }
    if (organicScore === null || organicScore < this.options.minOrganicScore) {
      reasons.push(`organicScore<${this.options.minOrganicScore}`);
    }
    if (organicScoreLabel === "low") {
      reasons.push("organicScoreLabel=low");
    }
    if (liquidityUsd !== null && liquidityUsd < this.options.minLiquidityUsd) {
      reasons.push(`jupiterLiquidity<${this.options.minLiquidityUsd}`);
    }
    if (holderCount !== null && holderCount < this.options.minHolderCount) {
      reasons.push(`holderCount<${this.options.minHolderCount}`);
    }
    if (topHoldersPercentage !== null && topHoldersPercentage > this.options.maxTopHoldersPct) {
      reasons.push(`topHolders>${this.options.maxTopHoldersPct}%`);
    }
    if (
      audit.devBalancePercentage !== null &&
      audit.devBalancePercentage !== undefined &&
      audit.devBalancePercentage > this.options.maxDevBalancePct
    ) {
      reasons.push(`devBalance>${this.options.maxDevBalancePct}%`);
    }
    if (!trusted && this.options.requireMintAuthorityDisabled && audit.mintAuthorityDisabled === false) {
      reasons.push("mint authority enabled");
    }
    if (!trusted && this.options.requireFreezeAuthorityDisabled && audit.freezeAuthorityDisabled === false) {
      reasons.push("freeze authority enabled");
    }

    return {
      mint,
      found: true,
      isDangerous: reasons.length > 0,
      isVerified: token.isVerified ?? null,
      organicScore,
      organicScoreLabel,
      liquidityUsd,
      holderCount,
      topHoldersPercentage,
      organicVolume1hUsd,
      organicBuyers1h,
      reasons,
      raw: token
    };
  }
}

function organicVolume(stats: JupiterTokenInfo["stats1h"]): number {
  return (stats?.buyOrganicVolume ?? 0) + (stats?.sellOrganicVolume ?? 0);
}
