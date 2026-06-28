import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { PositionStore } from "../state/PositionStore.js";
import { type MeteoraPool, SOL_MINT } from "../types.js";
import { RpcService } from "../services/RpcService.js";

export interface WalletAllocatorOptions {
  allocationPct: number;
  reserveSolPct: number;
  minPositionSolPct: number;
  maxPositionSolPct: number;
  minSolReserve: number;
  minPositionSol: number;
  maxPositionSol: number;
  maxTotalExposurePct: number;
  requireSolPool: boolean;
  solOnly: boolean;
}

export interface EntryAllocation {
  amountXUi: string;
  amountYUi: string;
  positionSol: number;
  walletSol: number;
  activeExposureSol: number;
  totalCapitalSol: number;
  reserveSol: number;
  minPositionSol: number;
  maxPositionSol: number;
  remainingDeployableSol: number;
  solPriceUsd: number;
  solSide: "x" | "y" | "none";
  autoFillBalancedAmounts: boolean;
  singleSidedX?: boolean;
}

export class WalletAllocator {
  constructor(
    private readonly rpc: RpcService,
    private readonly store: PositionStore,
    private readonly owner: PublicKey,
    private readonly options: WalletAllocatorOptions
  ) {}

  async allocate(pool: MeteoraPool): Promise<EntryAllocation | null> {
    const solSide = this.solSide(pool);
    if (this.options.requireSolPool && solSide === "none") {
      return null;
    }
    if (this.options.solOnly && solSide === "none") {
      return null;
    }

    const solPriceUsd = this.solPriceUsd(pool, solSide);
    if (solPriceUsd <= 0) {
      return null;
    }

    const walletSol = await this.walletSolBalance();
    const activeExposureSol = this.activeExposureSol(solPriceUsd);
    const totalCapitalSol = walletSol + activeExposureSol;
    const reserveSol = Math.max(this.options.minSolReserve, totalCapitalSol * (this.options.reserveSolPct / 100));
    const minPositionSol = Math.max(
      this.options.minPositionSol,
      totalCapitalSol * (this.options.minPositionSolPct / 100)
    );
    const dynamicMaxPositionSol = totalCapitalSol * (this.options.maxPositionSolPct / 100);
    const maxPositionSol =
      this.options.maxPositionSol > 0
        ? Math.min(dynamicMaxPositionSol, this.options.maxPositionSol)
        : dynamicMaxPositionSol;
    const maxDeployableSol = totalCapitalSol * (this.options.maxTotalExposurePct / 100);
    const remainingDeployableSol = Math.max(0, maxDeployableSol - activeExposureSol);
    const usableWalletSol = Math.max(0, walletSol - reserveSol);
    const targetPositionSol = totalCapitalSol * (this.options.allocationPct / 100);
    const positionSol = Math.min(targetPositionSol, usableWalletSol, remainingDeployableSol, maxPositionSol);

    if (positionSol < minPositionSol) {
      return null;
    }

    const allocation: EntryAllocation = {
      amountXUi: "0",
      amountYUi: "0",
      positionSol,
      walletSol,
      activeExposureSol,
      totalCapitalSol,
      reserveSol,
      minPositionSol,
      maxPositionSol,
      remainingDeployableSol,
      solPriceUsd,
      solSide,
      autoFillBalancedAmounts: !this.options.solOnly
    };

    if (solSide === "x") {
      allocation.amountXUi = formatSol(positionSol);
      if (this.options.solOnly) {
        allocation.singleSidedX = true;
      }
      return allocation;
    }

    if (solSide === "y") {
      allocation.amountYUi = formatSol(positionSol);
      if (this.options.solOnly) {
        allocation.singleSidedX = false;
      }
      return allocation;
    }

    return allocation;
  }

  async walletSolBalance(): Promise<number> {
    const lamports = await this.rpc.connection.getBalance(this.owner, "confirmed");
    return lamports / LAMPORTS_PER_SOL;
  }

  private activeExposureSol(solPriceUsd: number): number {
    if (solPriceUsd <= 0) {
      return 0;
    }
    return this.store
      .listActive()
      .reduce((sum, position) => sum + (position.lastSnapshot?.currentValueUsd ?? position.entryValueUsd), 0) / solPriceUsd;
  }

  private solSide(pool: MeteoraPool): EntryAllocation["solSide"] {
    if (pool.token_x.address === SOL_MINT) {
      return "x";
    }
    if (pool.token_y.address === SOL_MINT) {
      return "y";
    }
    return "none";
  }

  private solPriceUsd(pool: MeteoraPool, solSide: EntryAllocation["solSide"]): number {
    if (solSide === "x") {
      return finitePositive(pool.token_x.price);
    }
    if (solSide === "y") {
      return finitePositive(pool.token_y.price);
    }
    return 0;
  }
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatSol(value: number): string {
  return value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}
