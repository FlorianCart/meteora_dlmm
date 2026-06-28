import { config } from "./config.js";
import { MeteoraDlmmClient } from "./dlmm/MeteoraDlmmClient.js";
import { MonitoringLoop } from "./monitoring/MonitoringLoop.js";
import { PositionManager } from "./PositionManager.js";
import { WalletAllocator, type EntryAllocation } from "./risk/WalletAllocator.js";
import { PoolScanner } from "./scanner/PoolScanner.js";
import { DexScreenerApi } from "./services/DexScreenerApi.js";
import { HttpClient } from "./services/HttpClient.js";
import { JupiterTokenApi } from "./services/JupiterTokenApi.js";
import { JupiterSwapService } from "./services/JupiterSwapService.js";
import { MeteoraDataApi } from "./services/MeteoraDataApi.js";
import { PostExitSwapService } from "./services/PostExitSwapService.js";
import { RpcService } from "./services/RpcService.js";
import { RugCheckApi } from "./services/RugCheckApi.js";
import { PositionStore } from "./state/PositionStore.js";
import type { ExitReason, ManagedPositionState, ScoredPool } from "./types.js";
import { logger } from "./utils/logger.js";
import { sleep } from "./utils/time.js";
import { loadKeypair } from "./wallet.js";
import { PositionValuator } from "./valuation/PositionValuator.js";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const services = await buildServices();

  if (args.has("--exit-all")) {
    await exitAllPositions(services);
    return;
  }

  if (args.has("--sweep-to-sol")) {
    await sweepTrackedTokensToSol(services);
    return;
  }

  if (args.has("--monitor")) {
    await runMonitor(services);
    return;
  }

  const scored = await services.scanner.scan();
  printTopPools(scored);

  if (args.has("--scan") || !config.autoOpen) {
    return;
  }

  if (!services.owner) {
    throw new Error("AUTO_OPEN=true requires WALLET_PRIVATE_KEY.");
  }

  const selection = await selectEntry(scored, services);
  await openSelectedPosition(selection.target, selection.allocation, services, "Opened managed position");
  await runMonitor(services);
}

async function buildServices(): Promise<{
  scanner: PoolScanner;
  store: PositionStore;
  positionManager: PositionManager;
  monitor: MonitoringLoop;
  postExitSwap: PostExitSwapService | null;
  allocator: WalletAllocator | null;
  owner: ReturnType<typeof loadKeypair> | null;
}> {
  const meteoraData = new MeteoraDataApi(
    new HttpClient({
      baseUrl: config.apis.meteoraDataApiBase,
      retries: 3,
      timeoutMs: 12_000,
      minIntervalMs: 35
    })
  );

  const rugCheckHeaders = config.apis.rugCheckApiKey ? { Authorization: config.apis.rugCheckApiKey } : undefined;
  const rugCheckHttpOptions = {
    baseUrl: config.apis.rugCheckApiBase,
    retries: 2,
    timeoutMs: 12_000,
    minIntervalMs: 250,
    ...(rugCheckHeaders ? { defaultHeaders: rugCheckHeaders } : {})
  };

  const rugCheck = new RugCheckApi(
    new HttpClient(rugCheckHttpOptions),
    {
      maxNormalizedScore: config.apis.rugCheckMaxNormalizedScore,
      failClosed: config.apis.rugCheckFailClosed
    }
  );

  const dexScreener = config.apis.dexScreenerEnabled
    ? new DexScreenerApi(
        new HttpClient({
          baseUrl: config.apis.dexScreenerApiBase,
          retries: 2,
          timeoutMs: 12_000,
          minIntervalMs: 220
        })
      )
    : null;

  const jupiterHeaders = config.apis.jupiterApiKey ? { "x-api-key": config.apis.jupiterApiKey } : undefined;
  const jupiterHttpOptions = {
    baseUrl: config.apis.jupiterTokenApiBase,
    retries: 2,
    timeoutMs: 12_000,
    minIntervalMs: 120,
    ...(jupiterHeaders ? { defaultHeaders: jupiterHeaders } : {})
  };
  const jupiter = new JupiterTokenApi(new HttpClient(jupiterHttpOptions), {
    enabled: config.apis.jupiterEnabled,
    failClosed: config.apis.jupiterFailClosed,
    minOrganicScore: config.apis.jupiterMinOrganicScore,
    highConfidenceOrganicScore: config.apis.jupiterHighConfidenceOrganicScore,
    minLiquidityUsd: config.apis.jupiterMinLiquidityUsd,
    minHolderCount: config.apis.jupiterMinHolderCount,
    maxTopHoldersPct: config.apis.jupiterMaxTopHoldersPct,
    maxDevBalancePct: config.apis.jupiterMaxDevBalancePct,
    requireMintAuthorityDisabled: config.apis.jupiterRequireMintAuthorityDisabled,
    requireFreezeAuthorityDisabled: config.apis.jupiterRequireFreezeAuthorityDisabled
  });

  const scanner = new PoolScanner(meteoraData, rugCheck, jupiter, dexScreener, {
    ...config.scanner,
    concurrency: 6
  });

  const rpcOptions = {
    rpcUrl: config.rpc.url,
    commitment: config.rpc.commitment,
    priorityFeeMicroLamports: config.tx.priorityFeeMicroLamports,
    computeUnitLimit: config.tx.computeUnitLimit,
    maxRetries: config.tx.maxRetries,
    confirmTimeoutMs: config.tx.confirmTimeoutMs,
    skipPreflight: config.tx.skipPreflight,
    ...(config.rpc.wsUrl ? { wsUrl: config.rpc.wsUrl } : {})
  };
  const rpc = new RpcService(rpcOptions);

  const store = new PositionStore(config.positionStorePath);
  await store.load();

  const dlmm = new MeteoraDlmmClient(rpc);
  const valuator = new PositionValuator(meteoraData);
  const positionManager = new PositionManager(store, dlmm, valuator, config.maxOpenPositions);
  const owner = config.walletPrivateKey ? loadKeypair(config.walletPrivateKey) : null;
  const jupiterSwapHeaders = config.apis.jupiterApiKey ? { "x-api-key": config.apis.jupiterApiKey } : undefined;
  const postExitSwap = owner
    ? new PostExitSwapService(
        rpc,
        new JupiterSwapService(
          new HttpClient({
            baseUrl: config.apis.jupiterSwapApiBase,
            retries: 2,
            timeoutMs: 15_000,
            minIntervalMs: 150,
            ...(jupiterSwapHeaders ? { defaultHeaders: jupiterSwapHeaders } : {})
          }),
          rpc,
          {
            slippageBps: config.postExitSwap.slippageBps,
            restrictIntermediateTokens: config.postExitSwap.restrictIntermediateTokens
          }
        ),
        {
          enabled: config.postExitSwap.enabled,
          minSwapUsd: config.postExitSwap.minSwapUsd
        }
      )
    : null;
  const allocator = owner
    ? new WalletAllocator(rpc, store, owner.publicKey, {
        allocationPct: config.entry.walletAllocationPct,
        reserveSolPct: config.entry.reserveSolPct,
        minPositionSolPct: config.entry.minPositionSolPct,
        maxPositionSolPct: config.entry.maxPositionSolPct,
        minSolReserve: config.entry.minSolReserve,
        minPositionSol: config.entry.minPositionSol,
        maxPositionSol: config.entry.maxPositionSol,
        maxTotalExposurePct: config.entry.maxTotalExposurePct,
        requireSolPool: config.entry.requireSolPool,
        solOnly: config.entry.solOnly
      })
    : null;
  const autoReopen = createAutoReopenHandler({
    scanner,
    store,
    positionManager,
    allocator,
    owner
  });
  const monitor = new MonitoringLoop(store, positionManager, owner, config.monitor, postExitSwap, autoReopen);

  return {
    scanner,
    store,
    positionManager,
    monitor,
    postExitSwap,
    allocator,
    owner
  };
}

interface EntryRuntimeServices {
  scanner: PoolScanner;
  store: PositionStore;
  positionManager: PositionManager;
  allocator: WalletAllocator | null;
  owner: ReturnType<typeof loadKeypair> | null;
}

function createAutoReopenHandler(
  services: EntryRuntimeServices
): ((position: ManagedPositionState, reason: ExitReason) => Promise<void>) | null {
  if (!config.autoReopenAfterExit) {
    return null;
  }

  let queue = Promise.resolve();
  return async (closedPosition: ManagedPositionState, reason: ExitReason): Promise<void> => {
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        if (!services.owner) {
          logger.warn(
            { position: closedPosition.positionAddress, reason },
            "Auto-reopen skipped because WALLET_PRIVATE_KEY is missing"
          );
          return;
        }

        await sleep(config.autoReopenDelayMs);

        const activeCount = services.store.listActive().length;
        if (activeCount >= config.maxOpenPositions) {
          logger.info({ activeCount, maxOpenPositions: config.maxOpenPositions }, "Auto-reopen skipped at max capacity");
          return;
        }

        try {
          await openNextEligiblePosition(services, "Auto-opened replacement position");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ position: closedPosition.positionAddress, reason, error: message }, "Auto-reopen failed");
        }
      });

    await queue;
  };
}

async function openNextEligiblePosition(
  services: EntryRuntimeServices,
  logMessage: string
): Promise<ManagedPositionState> {
  const scored = await services.scanner.scan();
  printTopPools(scored);
  const selection = await selectEntry(scored, services);
  return openSelectedPosition(selection.target, selection.allocation, services, logMessage);
}

async function openSelectedPosition(
  target: ScoredPool,
  allocation: Pick<EntryAllocation, "amountXUi" | "amountYUi" | "autoFillBalancedAmounts" | "singleSidedX">,
  services: Pick<EntryRuntimeServices, "positionManager" | "owner">,
  logMessage: string
): Promise<ManagedPositionState> {
  if (!services.owner) {
    throw new Error("Opening a managed position requires WALLET_PRIVATE_KEY.");
  }

  const opened = await services.positionManager.open({
    pool: target.pool,
    owner: services.owner,
    amountXUi: allocation.amountXUi,
    amountYUi: allocation.amountYUi,
    rangeBins: config.entry.rangeBins,
    slippagePct: config.entry.slippagePct,
    takeProfitPct: config.entry.takeProfitPct,
    stopLossPct: config.entry.stopLossPct,
    autoFillBalancedAmounts: allocation.autoFillBalancedAmounts,
    ...(allocation.singleSidedX !== undefined ? { singleSidedX: allocation.singleSidedX } : {})
  });

  logger.info(
    {
      position: opened.positionAddress,
      pool: opened.poolAddress,
      rangeBins: config.entry.rangeBins,
      takeProfitPct: config.entry.takeProfitPct,
      stopLossPct: config.entry.stopLossPct
    },
    logMessage
  );
  return opened;
}

async function selectEntry(
  scored: ScoredPool[],
  services: { allocator: WalletAllocator | null; store: PositionStore }
): Promise<{
  target: ScoredPool;
  allocation: Pick<EntryAllocation, "amountXUi" | "amountYUi" | "autoFillBalancedAmounts" | "singleSidedX">;
}> {
  const activePools = new Set(services.store.listActive().map((position) => position.poolAddress));
  for (const target of scored) {
    if (!target.eligible || activePools.has(target.pool.address)) {
      continue;
    }

    const allocation = await resolveEntryAllocation(target, services);
    if (allocation) {
      return { target, allocation };
    }
  }

  throw new Error("No eligible pool found after scoring, risk filters, active-position checks, and wallet allocation.");
}

async function resolveEntryAllocation(
  target: ScoredPool,
  services: { allocator: WalletAllocator | null }
): Promise<Pick<EntryAllocation, "amountXUi" | "amountYUi" | "autoFillBalancedAmounts" | "singleSidedX"> | null> {
  if (config.entry.sizingMode === "fixed") {
    return {
      amountXUi: config.entry.tokenXAmountUi,
      amountYUi: config.entry.tokenYAmountUi,
      autoFillBalancedAmounts: true
    };
  }

  if (!services.allocator) {
    throw new Error("Wallet-ratio sizing requires WALLET_PRIVATE_KEY.");
  }

  const allocation = await services.allocator.allocate(target.pool);
  if (!allocation) {
    logger.debug({ pool: target.pool.name, address: target.pool.address }, "Wallet-ratio allocation skipped pool");
    return null;
  }

  logger.info(
    {
      pool: target.pool.name,
      amountXUi: allocation.amountXUi,
      amountYUi: allocation.amountYUi,
      positionSol: allocation.positionSol,
      walletSol: allocation.walletSol,
      activeExposureSol: allocation.activeExposureSol,
      totalCapitalSol: allocation.totalCapitalSol,
      reserveSol: allocation.reserveSol,
      minPositionSol: allocation.minPositionSol,
      maxPositionSol: allocation.maxPositionSol,
      remainingDeployableSol: allocation.remainingDeployableSol,
      solSide: allocation.solSide,
      solOnly: config.entry.solOnly
    },
    "Selected wallet-ratio entry allocation"
  );

  return allocation;
}

async function runMonitor(services: { monitor: MonitoringLoop }): Promise<void> {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await services.monitor.run(controller.signal);
}

async function exitAllPositions(services: {
  store: PositionStore;
  positionManager: PositionManager;
  postExitSwap: PostExitSwapService | null;
  owner: ReturnType<typeof loadKeypair> | null;
}): Promise<void> {
  if (!services.owner) {
    throw new Error("--exit-all requires WALLET_PRIVATE_KEY.");
  }

  const active = services.store.listActive();
  if (active.length === 0) {
    logger.info("No active positions to exit");
    return;
  }

  for (const position of active) {
    logger.warn(
      {
        position: position.positionAddress,
        pool: position.poolAddress,
        status: position.status
      },
      "Manually exiting tracked position"
    );
    await services.store.setStatus(position.id, "EXITING", "MANUAL");
    const txs = await services.positionManager.exit(position, services.owner);
    await services.store.recordClosed(position.id, txs, new Date().toISOString(), "MANUAL");
    await services.postExitSwap?.sweepPositionTokensToSol(position, services.owner);
    logger.info({ position: position.positionAddress, txs }, "Manual exit complete");
  }
}

async function sweepTrackedTokensToSol(services: {
  store: PositionStore;
  postExitSwap: PostExitSwapService | null;
  owner: ReturnType<typeof loadKeypair> | null;
}): Promise<void> {
  if (!services.owner) {
    throw new Error("--sweep-to-sol requires WALLET_PRIVATE_KEY.");
  }
  if (!services.postExitSwap) {
    throw new Error("Post-exit swap service is not available.");
  }

  const positions = services.store.list();
  const swaps = await services.postExitSwap.sweepTrackedTokensToSol(positions, services.owner);
  logger.info({ swaps }, "Tracked token sweep to SOL complete");
}

function printTopPools(scored: ScoredPool[]): void {
  const rows = scored.slice(0, 10).map((item) => ({
    score: item.score.toFixed(2),
    eligible: item.eligible,
    pool: item.pool.name,
    address: item.pool.address,
    ageH: ((Date.now() - item.pool.created_at) / 3_600_000).toFixed(1),
    tvl: item.pool.tvl.toFixed(0),
    volume30m: item.pool.volume["30m"].toFixed(0),
    feeTvl30m: item.pool.fee_tvl_ratio["30m"].toFixed(2),
    feeTvl1h: item.pool.fee_tvl_ratio["1h"].toFixed(2),
    volume24h: item.pool.volume["24h"].toFixed(0),
    feeTvl24h: item.pool.fee_tvl_ratio["24h"].toFixed(2),
    jup: item.jupiter.map((token) => token.organicScore?.toFixed(0) ?? "na").join("/"),
    reasons: item.reasons.join("; ")
  }));
  console.table(rows);
}

main().catch((error) => {
  logger.error(error, "Fatal error");
  process.exitCode = 1;
});
