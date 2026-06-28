import { Keypair } from "@solana/web3.js";
import pLimit from "p-limit";
import { PositionManager } from "../PositionManager.js";
import { PositionStore } from "../state/PositionStore.js";
import type { ExitReason, ManagedPositionState } from "../types.js";
import { logger } from "../utils/logger.js";
import { jitter, nowIso, sleep } from "../utils/time.js";

export interface MonitoringLoopOptions {
  intervalMs: number;
  concurrency: number;
}

export class MonitoringLoop {
  constructor(
    private readonly store: PositionStore,
    private readonly manager: PositionManager,
    private readonly owner: Keypair | null,
    private readonly options: MonitoringLoopOptions
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      await this.tick();
      await sleep(jitter(this.options.intervalMs, 0.15));
    }
  }

  async tick(): Promise<void> {
    const active = this.store.listActive();
    if (active.length === 0) {
      logger.info("No active positions to monitor");
      return;
    }

    const limit = pLimit(this.options.concurrency);
    await Promise.all(active.map((position) => limit(() => this.monitorPosition(position))));
  }

  private async monitorPosition(position: ManagedPositionState): Promise<void> {
    try {
      if (position.status === "EXITING") {
        await this.exit(position, position.exitReason ?? "MANUAL");
        return;
      }

      const snapshot = await this.manager.evaluate(position);
      await this.store.recordSnapshot(position.id, snapshot);
      logger.info(
        {
          position: position.positionAddress,
          pool: position.poolAddress,
          profitPct: snapshot.profitPct,
          feeYieldPct: snapshot.feeYieldPct,
          impermanentLossUsd: snapshot.impermanentLossUsd
        },
        "Position snapshot"
      );

      if (snapshot.profitPct >= position.takeProfitPct) {
        logger.info(
          {
            position: position.positionAddress,
            profitPct: snapshot.profitPct,
            takeProfitPct: position.takeProfitPct
          },
          "Take-profit reached"
        );
        await this.store.setStatus(position.id, "EXITING", "TAKE_PROFIT");
        await this.exit({ ...position, status: "EXITING", lastSnapshot: snapshot }, "TAKE_PROFIT");
        return;
      }

      const stopLossPct = Number.isFinite(position.stopLossPct) ? position.stopLossPct : Number.NEGATIVE_INFINITY;
      if (snapshot.profitPct <= stopLossPct) {
        logger.warn(
          {
            position: position.positionAddress,
            profitPct: snapshot.profitPct,
            stopLossPct
          },
          "Stop-loss reached"
        );
        await this.store.setStatus(position.id, "EXITING", "STOP_LOSS");
        await this.exit({ ...position, status: "EXITING", lastSnapshot: snapshot }, "STOP_LOSS");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.recordError(position.id, message);
      logger.error({ position: position.positionAddress, error: message }, "Position monitoring failed");
    }
  }

  private async exit(position: ManagedPositionState, reason: ExitReason): Promise<void> {
    if (!this.owner) {
      throw new Error("Wallet is required to exit a managed position.");
    }

    const txs = await this.manager.exit(position, this.owner);
    await this.store.recordClosed(position.id, txs, nowIso(), reason);
    logger.info({ position: position.positionAddress, txs, reason }, "Position closed");
  }
}
