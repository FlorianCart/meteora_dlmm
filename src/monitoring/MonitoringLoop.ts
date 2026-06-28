import { Keypair } from "@solana/web3.js";
import pLimit from "p-limit";
import { PositionManager } from "../PositionManager.js";
import { PostExitSwapService } from "../services/PostExitSwapService.js";
import { PositionStore } from "../state/PositionStore.js";
import type { ExitReason, ManagedPositionState, OutOfRangeDirection, ProfitSnapshot } from "../types.js";
import { logger } from "../utils/logger.js";
import { jitter, nowIso, sleep } from "../utils/time.js";

export interface MonitoringLoopOptions {
  intervalMs: number;
  concurrency: number;
  outOfRangeUpExitEnabled: boolean;
  outOfRangeUpCooldownMs: number;
}

export type PositionClosedHandler = (position: ManagedPositionState, reason: ExitReason) => Promise<void>;

export class MonitoringLoop {
  constructor(
    private readonly store: PositionStore,
    private readonly manager: PositionManager,
    private readonly owner: Keypair | null,
    private readonly options: MonitoringLoopOptions,
    private readonly postExitSwap: PostExitSwapService | null = null,
    private readonly onPositionClosed: PositionClosedHandler | null = null
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
      const trackedPosition = this.store.get(position.id) ?? position;
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
        await this.exit({ ...trackedPosition, status: "EXITING", lastSnapshot: snapshot }, "TAKE_PROFIT");
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
        await this.exit({ ...trackedPosition, status: "EXITING", lastSnapshot: snapshot }, "STOP_LOSS");
        return;
      }

      if (await this.handleOutOfRange(trackedPosition, snapshot)) {
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.recordError(position.id, message);
      logger.error({ position: position.positionAddress, error: message }, "Position monitoring failed");
    }
  }

  private async handleOutOfRange(position: ManagedPositionState, snapshot: ProfitSnapshot): Promise<boolean> {
    if (!this.options.outOfRangeUpExitEnabled) {
      return false;
    }

    const direction = getOutOfRangeDirection(snapshot.activeBinId, position.lowerBinId, position.upperBinId);
    if (direction !== "ABOVE") {
      if (position.outOfRangeDirection || position.outOfRangeSince) {
        await this.store.clearOutOfRange(position.id);
        logger.info(
          {
            position: position.positionAddress,
            activeBinId: snapshot.activeBinId,
            lowerBinId: position.lowerBinId,
            upperBinId: position.upperBinId
          },
          "Position no longer out of range above; cooldown cleared"
        );
      }
      return false;
    }

    const existingSince = position.outOfRangeDirection === "ABOVE" ? position.outOfRangeSince : undefined;
    const since = existingSince ?? snapshot.timestamp;

    if (!existingSince) {
      await this.store.recordOutOfRange(position.id, "ABOVE", since);
      logger.warn(
        {
          position: position.positionAddress,
          activeBinId: snapshot.activeBinId,
          upperBinId: position.upperBinId,
          cooldownMs: this.options.outOfRangeUpCooldownMs
        },
        "Position out of range above; cooldown started"
      );
      return false;
    }

    const elapsedMs = elapsedSinceMs(since, snapshot.timestamp);
    if (elapsedMs < this.options.outOfRangeUpCooldownMs) {
      logger.warn(
        {
          position: position.positionAddress,
          activeBinId: snapshot.activeBinId,
          upperBinId: position.upperBinId,
          elapsedMs,
          remainingMs: this.options.outOfRangeUpCooldownMs - elapsedMs
        },
        "Position still out of range above; cooldown active"
      );
      return false;
    }

    logger.warn(
      {
        position: position.positionAddress,
        activeBinId: snapshot.activeBinId,
        upperBinId: position.upperBinId,
        elapsedMs
      },
      "Position out of range above cooldown elapsed; exiting"
    );
    await this.store.setStatus(position.id, "EXITING", "OUT_OF_RANGE_UP");
    await this.exit(
      { ...position, status: "EXITING", lastSnapshot: snapshot, exitReason: "OUT_OF_RANGE_UP" },
      "OUT_OF_RANGE_UP"
    );
    return true;
  }

  private async exit(position: ManagedPositionState, reason: ExitReason): Promise<void> {
    if (!this.owner) {
      throw new Error("Wallet is required to exit a managed position.");
    }

    const txs = await this.manager.exit(position, this.owner);
    await this.store.recordClosed(position.id, txs, nowIso(), reason);
    const closedPosition = this.store.get(position.id) ?? position;

    if (this.postExitSwap) {
      try {
        await this.postExitSwap.sweepPositionTokensToSol(position, this.owner);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ position: position.positionAddress, error: message }, "Post-exit SOL sweep failed");
      }
    }

    logger.info({ position: position.positionAddress, txs, reason }, "Position closed");

    if (this.onPositionClosed) {
      await this.onPositionClosed(closedPosition, reason);
    }
  }
}

function getOutOfRangeDirection(activeBinId: number, lowerBinId: number, upperBinId: number): OutOfRangeDirection | null {
  if (activeBinId > upperBinId) {
    return "ABOVE";
  }
  if (activeBinId < lowerBinId) {
    return "BELOW";
  }
  return null;
}

function elapsedSinceMs(sinceIso: string, nowIsoValue: string): number {
  const sinceMs = Date.parse(sinceIso);
  const nowMs = Date.parse(nowIsoValue);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(nowMs)) {
    return 0;
  }
  return Math.max(0, nowMs - sinceMs);
}
