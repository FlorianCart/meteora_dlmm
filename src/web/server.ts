import express from "express";
import { resolve } from "node:path";
import { config } from "../config.js";
import { PaperBotEngine } from "../paper/PaperBotEngine.js";
import { PaperStore } from "../paper/PaperStore.js";
import { createScannerStack } from "../serviceFactory.js";
import { PositionStore } from "../state/PositionStore.js";
import type { ManagedPositionState } from "../types.js";
import { logger } from "../utils/logger.js";

interface LiveStatus {
  positionStorePath: string;
  updatedAt: string | null;
  outOfRangeUpCooldownMs: number;
  autoReopenAfterExit: boolean;
  activeCount: number;
  closedCount: number;
  entryValueUsd: number;
  liquidityValueUsd: number;
  currentValueUsd: number;
  profitUsd: number;
  profitPct: number;
  feeValueUsd: number;
  positions: ManagedPositionState[];
}

async function main(): Promise<void> {
  const { scanner, meteoraData } = createScannerStack();
  const store = new PaperStore(config.paper.statePath, config.paper.startingBalanceUsd);
  await store.load();

  const engine = new PaperBotEngine(store, scanner, meteoraData, {
    positionSizeUsd: config.paper.positionSizeUsd,
    maxPositions: config.paper.maxPositions,
    scanIntervalMs: config.paper.scanIntervalMs,
    takeProfitPct: config.paper.takeProfitPct,
    stopLossPct: config.paper.stopLossPct,
    maxFeeRatePerHourPct: config.paper.maxFeeRatePerHourPct
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(express.static(resolve(process.cwd(), "web")));

  app.get("/api/status", async (_req, res, next) => {
    try {
      res.json(await engine.status());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/live/status", async (_req, res, next) => {
    try {
      res.json(await liveStatus());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/bot/start", async (_req, res, next) => {
    try {
      res.json(await engine.start());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/bot/stop", async (_req, res, next) => {
    try {
      res.json(await engine.stop());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/bot/tick", async (_req, res, next) => {
    try {
      res.json(await engine.tick());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/paper/reset", async (req, res, next) => {
    try {
      const balanceUsd = typeof req.body?.balanceUsd === "number" ? req.body.balanceUsd : undefined;
      res.json(await engine.reset(balanceUsd));
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(error, "Web request failed");
    res.status(500).json({ error: message });
  });

  app.listen(config.web.port, config.web.host, () => {
    logger.info(`Paper dashboard listening on http://${config.web.host}:${config.web.port}`);
  });
}

async function liveStatus(): Promise<LiveStatus> {
  const store = new PositionStore(config.positionStorePath);
  await store.load();
  const positions = store.list();
  const active = positions.filter((position) => position.status === "OPEN" || position.status === "EXITING");
  const closed = positions.filter((position) => position.status === "CLOSED");
  const entryValueUsd = active.reduce((sum, position) => sum + position.entryValueUsd, 0);
  const liquidityValueUsd = active.reduce((sum, position) => {
    const snapshot = position.lastSnapshot;
    return sum + (snapshot?.liquidityValueUsd ?? snapshot?.currentValueUsd ?? position.entryValueUsd);
  }, 0);
  const currentValueUsd = active.reduce(
    (sum, position) => sum + (position.lastSnapshot?.currentValueUsd ?? position.entryValueUsd),
    0
  );
  const feeValueUsd = active.reduce((sum, position) => sum + (position.lastSnapshot?.feeValueUsd ?? 0), 0);
  const profitUsd = currentValueUsd - entryValueUsd;
  const profitPct = entryValueUsd > 0 ? (profitUsd / entryValueUsd) * 100 : 0;
  const updatedAt = latestLiveUpdate(positions);

  return {
    positionStorePath: config.positionStorePath,
    updatedAt,
    outOfRangeUpCooldownMs: config.monitor.outOfRangeUpCooldownMs,
    autoReopenAfterExit: config.autoReopenAfterExit,
    activeCount: active.length,
    closedCount: closed.length,
    entryValueUsd,
    liquidityValueUsd,
    currentValueUsd,
    profitUsd,
    profitPct,
    feeValueUsd,
    positions
  };
}

function latestLiveUpdate(positions: ManagedPositionState[]): string | null {
  const timestamps = positions
    .flatMap((position) => [position.lastSnapshot?.timestamp, position.closedAt, position.openedAt])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);

  if (timestamps.length === 0) {
    return null;
  }
  return new Date(Math.max(...timestamps)).toISOString();
}

main().catch((error) => {
  logger.error(error, "Paper dashboard failed");
  process.exitCode = 1;
});
