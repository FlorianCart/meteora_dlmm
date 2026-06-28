import { config } from "./config.js";
import { PoolScanner } from "./scanner/PoolScanner.js";
import { DexScreenerApi } from "./services/DexScreenerApi.js";
import { HttpClient } from "./services/HttpClient.js";
import { JupiterTokenApi } from "./services/JupiterTokenApi.js";
import { MeteoraDataApi } from "./services/MeteoraDataApi.js";
import { RugCheckApi } from "./services/RugCheckApi.js";

export interface ScannerStack {
  meteoraData: MeteoraDataApi;
  scanner: PoolScanner;
}

export function createScannerStack(): ScannerStack {
  const meteoraData = new MeteoraDataApi(
    new HttpClient({
      baseUrl: config.apis.meteoraDataApiBase,
      retries: 3,
      timeoutMs: 12_000,
      minIntervalMs: 35
    })
  );

  const rugCheckHeaders = config.apis.rugCheckApiKey ? { Authorization: config.apis.rugCheckApiKey } : undefined;
  const rugCheck = new RugCheckApi(
    new HttpClient({
      baseUrl: config.apis.rugCheckApiBase,
      retries: 2,
      timeoutMs: 12_000,
      minIntervalMs: 250,
      ...(rugCheckHeaders ? { defaultHeaders: rugCheckHeaders } : {})
    }),
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
  const jupiter = new JupiterTokenApi(
    new HttpClient({
      baseUrl: config.apis.jupiterTokenApiBase,
      retries: 2,
      timeoutMs: 12_000,
      minIntervalMs: 120,
      ...(jupiterHeaders ? { defaultHeaders: jupiterHeaders } : {})
    }),
    {
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
    }
  );

  return {
    meteoraData,
    scanner: new PoolScanner(meteoraData, rugCheck, jupiter, dexScreener, {
      ...config.scanner,
      concurrency: 6
    })
  };
}
