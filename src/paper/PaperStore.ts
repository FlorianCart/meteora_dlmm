import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PaperEvent {
  id: string;
  at: string;
  type: "INFO" | "OPEN" | "CLOSE" | "ERROR" | "SCAN";
  message: string;
  poolAddress?: string;
  positionId?: string;
}

export interface PaperSnapshot {
  at: string;
  equityUsd: number;
  cashUsd: number;
  openValueUsd: number;
  realizedPnlUsd: number;
  openPositions: number;
}

export interface PaperPosition {
  id: string;
  poolAddress: string;
  poolName: string;
  tokenX: {
    address: string;
    symbol: string;
    decimals: number;
  };
  tokenY: {
    address: string;
    symbol: string;
    decimals: number;
  };
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt?: string;
  exitReason?: string;
  notionalUsd: number;
  entryValueUsd: number;
  entryTokenXPriceUsd: number;
  entryTokenYPriceUsd: number;
  tokenXAmount: number;
  tokenYAmount: number;
  currentTokenXPriceUsd: number;
  currentTokenYPriceUsd: number;
  currentValueUsd: number;
  feesAccruedUsd: number;
  pnlUsd: number;
  pnlPct: number;
  lastValuedAt: string;
  scoreAtEntry: number;
  feeTvlRatio30mAtEntry: number;
  feeTvlRatio1hAtEntry: number;
  feeTvlRatio24hAtEntry: number;
  jupiterScoresAtEntry: string;
  snapshots: PaperPositionSnapshot[];
}

export interface PaperPositionSnapshot {
  at: string;
  priceX: number;
  priceY: number;
  valueUsd: number;
  feesUsd: number;
  pnlUsd: number;
  pnlPct: number;
  feeRatePerHourPct: number;
}

export interface PaperState {
  createdAt: string;
  updatedAt: string;
  cashUsd: number;
  startingBalanceUsd: number;
  realizedPnlUsd: number;
  positions: PaperPosition[];
  events: PaperEvent[];
  equityHistory: PaperSnapshot[];
}

export class PaperStore {
  private state: PaperState | null = null;

  constructor(
    private readonly filePath: string,
    private readonly startingBalanceUsd: number
  ) {}

  async load(): Promise<PaperState> {
    if (this.state) {
      return this.state;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = JSON.parse(raw) as PaperState;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      this.state = this.emptyState(this.startingBalanceUsd);
      await this.save();
    }

    return this.state;
  }

  async replace(state: PaperState): Promise<void> {
    this.state = state;
    await this.save();
  }

  async reset(balanceUsd = this.startingBalanceUsd): Promise<PaperState> {
    this.state = this.emptyState(balanceUsd);
    await this.save();
    return this.state;
  }

  async save(): Promise<void> {
    if (!this.state) {
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }

  private emptyState(balanceUsd: number): PaperState {
    const now = new Date().toISOString();
    return {
      createdAt: now,
      updatedAt: now,
      cashUsd: balanceUsd,
      startingBalanceUsd: balanceUsd,
      realizedPnlUsd: 0,
      positions: [],
      events: [],
      equityHistory: []
    };
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
