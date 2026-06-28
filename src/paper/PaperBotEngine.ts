import { randomUUID } from "node:crypto";
import type { MeteoraPool, ScoredPool } from "../types.js";
import { MeteoraDataApi } from "../services/MeteoraDataApi.js";
import { PoolScanner } from "../scanner/PoolScanner.js";
import { logger } from "../utils/logger.js";
import { nowIso, sleep } from "../utils/time.js";
import type { PaperEvent, PaperPosition, PaperPositionSnapshot, PaperSnapshot, PaperState } from "./PaperStore.js";
import { PaperStore } from "./PaperStore.js";

export interface PaperBotOptions {
  positionSizeUsd: number;
  maxPositions: number;
  scanIntervalMs: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxFeeRatePerHourPct: number;
}

export interface PaperBotStatus {
  running: boolean;
  busy: boolean;
  lastTickAt: string | null;
  nextTickAt: string | null;
  state: PaperState;
  metrics: PaperMetrics;
  lastScan: ScoredPool[];
  options: PaperBotOptions;
}

export interface PaperMetrics {
  equityUsd: number;
  openValueUsd: number;
  cashUsd: number;
  realizedPnlUsd: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  openPositions: number;
  closedPositions: number;
  winRatePct: number;
}

export class PaperBotEngine {
  private running = false;
  private busy = false;
  private loopPromise: Promise<void> | null = null;
  private lastTickAt: string | null = null;
  private nextTickAt: string | null = null;
  private lastScan: ScoredPool[] = [];

  constructor(
    private readonly store: PaperStore,
    private readonly scanner: PoolScanner,
    private readonly meteoraData: MeteoraDataApi,
    private readonly options: PaperBotOptions
  ) {}

  async status(): Promise<PaperBotStatus> {
    const state = await this.store.load();
    return {
      running: this.running,
      busy: this.busy,
      lastTickAt: this.lastTickAt,
      nextTickAt: this.nextTickAt,
      state,
      metrics: this.metrics(state),
      lastScan: this.lastScan,
      options: this.options
    };
  }

  async start(): Promise<PaperBotStatus> {
    await this.store.load();
    if (!this.running) {
      this.running = true;
      this.loopPromise = this.loop();
      await this.addEvent("INFO", "Paper bot started");
    }
    void this.tick();
    return this.status();
  }

  async stop(): Promise<PaperBotStatus> {
    this.running = false;
    this.nextTickAt = null;
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = null;
    await this.addEvent("INFO", "Paper bot stopped");
    return this.status();
  }

  async reset(balanceUsd?: number): Promise<PaperBotStatus> {
    this.running = false;
    this.nextTickAt = null;
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = null;
    await this.store.reset(balanceUsd);
    await this.addEvent("INFO", `Paper state reset to $${(balanceUsd ?? this.options.positionSizeUsd).toFixed(0)}`);
    return this.status();
  }

  async tick(): Promise<PaperBotStatus> {
    if (this.busy) {
      return this.status();
    }

    this.busy = true;
    try {
      const state = await this.store.load();
      await this.refreshOpenPositions(state);
      this.lastScan = await this.scanner.scan();
      await this.addEvent("SCAN", `Scanner refreshed ${this.lastScan.length} candidates`);

      if (this.running) {
        await this.openEligiblePositions(state, this.lastScan);
      }

      this.recordEquity(state);
      state.updatedAt = nowIso();
      await this.store.replace(state);
      this.lastTickAt = state.updatedAt;
      return this.status();
    } catch (error) {
      await this.addEvent("ERROR", error instanceof Error ? error.message : String(error));
      logger.error(error, "Paper tick failed");
      return this.status();
    } finally {
      this.busy = false;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const nextAt = Date.now() + this.options.scanIntervalMs;
      this.nextTickAt = new Date(nextAt).toISOString();
      await sleep(this.options.scanIntervalMs);
      if (this.running) {
        await this.tick();
      }
    }
  }

  private async refreshOpenPositions(state: PaperState): Promise<void> {
    const open = state.positions.filter((position) => position.status === "OPEN");
    for (const position of open) {
      try {
        const pool = await this.meteoraData.getPool(position.poolAddress);
        this.valuePosition(position, pool);
        if (position.pnlPct >= this.options.takeProfitPct) {
          this.closePosition(state, position, "TAKE_PROFIT");
        } else if (position.pnlPct <= this.options.stopLossPct) {
          this.closePosition(state, position, "STOP_LOSS");
        }
      } catch (error) {
        await this.addEvent(
          "ERROR",
          `Failed to value ${position.poolName}: ${error instanceof Error ? error.message : String(error)}`,
          position.poolAddress,
          position.id
        );
      }
    }
  }

  private async openEligiblePositions(state: PaperState, scan: ScoredPool[]): Promise<void> {
    const activePools = new Set(
      state.positions.filter((position) => position.status === "OPEN").map((position) => position.poolAddress)
    );

    for (const candidate of scan) {
      const openCount = state.positions.filter((position) => position.status === "OPEN").length;
      if (openCount >= this.options.maxPositions || state.cashUsd < this.options.positionSizeUsd) {
        break;
      }
      if (!candidate.eligible || activePools.has(candidate.pool.address)) {
        continue;
      }

      const position = this.createPosition(candidate);
      state.cashUsd -= position.notionalUsd;
      state.positions.push(position);
      activePools.add(position.poolAddress);
      await this.addEvent("OPEN", `Opened paper position ${position.poolName}`, position.poolAddress, position.id);
    }
  }

  private createPosition(candidate: ScoredPool): PaperPosition {
    const pool = candidate.pool;
    if (pool.token_x.price <= 0 || pool.token_y.price <= 0) {
      throw new Error(`Pool ${pool.name} has invalid token prices`);
    }

    const half = this.options.positionSizeUsd / 2;
    const tokenXAmount = half / pool.token_x.price;
    const tokenYAmount = half / pool.token_y.price;
    const now = nowIso();

    return {
      id: randomUUID(),
      poolAddress: pool.address,
      poolName: pool.name,
      tokenX: {
        address: pool.token_x.address,
        symbol: pool.token_x.symbol,
        decimals: pool.token_x.decimals
      },
      tokenY: {
        address: pool.token_y.address,
        symbol: pool.token_y.symbol,
        decimals: pool.token_y.decimals
      },
      status: "OPEN",
      openedAt: now,
      notionalUsd: this.options.positionSizeUsd,
      entryValueUsd: this.options.positionSizeUsd,
      entryTokenXPriceUsd: pool.token_x.price,
      entryTokenYPriceUsd: pool.token_y.price,
      tokenXAmount,
      tokenYAmount,
      currentTokenXPriceUsd: pool.token_x.price,
      currentTokenYPriceUsd: pool.token_y.price,
      currentValueUsd: this.options.positionSizeUsd,
      feesAccruedUsd: 0,
      pnlUsd: 0,
      pnlPct: 0,
      lastValuedAt: now,
      scoreAtEntry: candidate.score,
      feeTvlRatio30mAtEntry: pool.fee_tvl_ratio["30m"],
      feeTvlRatio1hAtEntry: pool.fee_tvl_ratio["1h"],
      feeTvlRatio24hAtEntry: pool.fee_tvl_ratio["24h"],
      jupiterScoresAtEntry: candidate.jupiter.map((item) => item.organicScore?.toFixed(0) ?? "na").join("/"),
      snapshots: []
    };
  }

  private valuePosition(position: PaperPosition, pool: MeteoraPool): void {
    const now = nowIso();
    const elapsedHours = Math.max(0, (Date.parse(now) - Date.parse(position.lastValuedAt)) / 3_600_000);
    const feeRatePerHourPct = this.estimatedFeeRatePerHour(pool);
    const feeIncrement = position.notionalUsd * (feeRatePerHourPct / 100) * elapsedHours;
    position.feesAccruedUsd += feeIncrement;

    const tokenValue =
      position.tokenXAmount * pool.token_x.price +
      position.tokenYAmount * pool.token_y.price;
    position.currentTokenXPriceUsd = pool.token_x.price;
    position.currentTokenYPriceUsd = pool.token_y.price;
    position.currentValueUsd = tokenValue + position.feesAccruedUsd;
    position.pnlUsd = position.currentValueUsd - position.entryValueUsd;
    position.pnlPct = (position.pnlUsd / position.entryValueUsd) * 100;
    position.lastValuedAt = now;
    position.snapshots.push(this.positionSnapshot(position, feeRatePerHourPct));
    position.snapshots = position.snapshots.slice(-120);
  }

  private estimatedFeeRatePerHour(pool: MeteoraPool): number {
    const from30m = (pool.fee_tvl_ratio["30m"] ?? 0) * 2;
    const from1h = pool.fee_tvl_ratio["1h"] ?? 0;
    const from24h = (pool.fee_tvl_ratio["24h"] ?? 0) / 24;
    return Math.max(0, Math.min(this.options.maxFeeRatePerHourPct, Math.max(from30m, from1h, from24h)));
  }

  private closePosition(state: PaperState, position: PaperPosition, reason: string): void {
    if (position.status === "CLOSED") {
      return;
    }
    position.status = "CLOSED";
    position.closedAt = nowIso();
    position.exitReason = reason;
    state.cashUsd += position.currentValueUsd;
    state.realizedPnlUsd += position.pnlUsd;
    state.events.unshift({
      id: randomUUID(),
      at: position.closedAt,
      type: "CLOSE",
      message: `Closed ${position.poolName}: ${reason}`,
      poolAddress: position.poolAddress,
      positionId: position.id
    });
    state.events = state.events.slice(0, 200);
  }

  private recordEquity(state: PaperState): void {
    const openValueUsd = state.positions
      .filter((position) => position.status === "OPEN")
      .reduce((sum, position) => sum + position.currentValueUsd, 0);
    const equityUsd = state.cashUsd + openValueUsd;
    state.equityHistory.push({
      at: nowIso(),
      equityUsd,
      cashUsd: state.cashUsd,
      openValueUsd,
      realizedPnlUsd: state.realizedPnlUsd,
      openPositions: state.positions.filter((position) => position.status === "OPEN").length
    });
    state.equityHistory = state.equityHistory.slice(-240);
  }

  private metrics(state: PaperState): PaperMetrics {
    const open = state.positions.filter((position) => position.status === "OPEN");
    const closed = state.positions.filter((position) => position.status === "CLOSED");
    const openValueUsd = open.reduce((sum, position) => sum + position.currentValueUsd, 0);
    const equityUsd = state.cashUsd + openValueUsd;
    const totalPnlUsd = equityUsd - state.startingBalanceUsd;
    const winners = closed.filter((position) => position.pnlUsd > 0).length;
    return {
      equityUsd,
      openValueUsd,
      cashUsd: state.cashUsd,
      realizedPnlUsd: state.realizedPnlUsd,
      totalPnlUsd,
      totalPnlPct: (totalPnlUsd / state.startingBalanceUsd) * 100,
      openPositions: open.length,
      closedPositions: closed.length,
      winRatePct: closed.length === 0 ? 0 : (winners / closed.length) * 100
    };
  }

  private positionSnapshot(position: PaperPosition, feeRatePerHourPct: number): PaperPositionSnapshot {
    return {
      at: nowIso(),
      priceX: position.currentTokenXPriceUsd,
      priceY: position.currentTokenYPriceUsd,
      valueUsd: position.currentValueUsd,
      feesUsd: position.feesAccruedUsd,
      pnlUsd: position.pnlUsd,
      pnlPct: position.pnlPct,
      feeRatePerHourPct
    };
  }

  private async addEvent(
    type: PaperEvent["type"],
    message: string,
    poolAddress?: string,
    positionId?: string
  ): Promise<void> {
    const state = await this.store.load();
    const event: PaperEvent = {
      id: randomUUID(),
      at: nowIso(),
      type,
      message
    };
    if (poolAddress) {
      event.poolAddress = poolAddress;
    }
    if (positionId) {
      event.positionId = positionId;
    }
    state.events.unshift(event);
    state.events = state.events.slice(0, 200);
    state.updatedAt = nowIso();
    await this.store.replace(state);
  }
}
