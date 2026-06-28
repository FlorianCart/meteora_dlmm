import "dotenv/config";
import { z } from "zod";

function boolDefault(defaultValue: boolean) {
  return z
    .preprocess(
      (value) => (value === undefined || value === "" ? String(defaultValue) : value),
      z.union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    )
    .transform((value) => value === "true" || value === "1");
}

function normalizeStopLossPct(value: number): number {
  return value > 0 ? -value : value;
}

const optionalUrl = z
  .string()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const optionalNumber = z
  .string()
  .optional()
  .transform((value) => (value && value.length > 0 ? Number(value) : undefined));

function resolveRangeBins(rangeBins: number | undefined, legacyHalfWidthBins: number | undefined): number {
  const requested = rangeBins ?? (legacyHalfWidthBins !== undefined ? legacyHalfWidthBins * 2 + 1 : 69);
  return Math.max(69, requested);
}

const schema = z.object({
  RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  RPC_WS_URL: optionalUrl,
  COMMITMENT: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
  WALLET_PRIVATE_KEY: z.string().optional(),
  AUTO_OPEN: boolDefault(false),
  POSITION_STORE_PATH: z.string().default("./data/positions.json"),
  MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).max(10).default(10),
  MONITOR_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  MONITOR_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  TAKE_PROFIT_PCT: z.coerce.number().min(0.01).default(5),
  STOP_LOSS_PCT: z.coerce.number().default(-12),
  ENTRY_SIZING_MODE: z.enum(["fixed", "wallet-ratio"]).default("wallet-ratio"),
  ENTRY_TOKEN_X_AMOUNT_UI: z.string().default("0"),
  ENTRY_TOKEN_Y_AMOUNT_UI: z.string().default("0"),
  ENTRY_WALLET_ALLOCATION_PCT: z.coerce.number().min(0.1).max(100).default(25),
  ENTRY_RESERVE_SOL_PCT: z.coerce.number().min(0).max(100).default(10),
  ENTRY_MIN_POSITION_SOL_PCT: z.coerce.number().min(0).max(100).default(4),
  ENTRY_MAX_POSITION_SOL_PCT: z.coerce.number().min(0.1).max(100).default(20),
  ENTRY_MIN_SOL_RESERVE: z.coerce.number().min(0).default(0),
  ENTRY_MIN_POSITION_SOL: z.coerce.number().min(0).default(0),
  ENTRY_MAX_POSITION_SOL: z.coerce.number().min(0).default(0),
  ENTRY_MAX_TOTAL_EXPOSURE_PCT: z.coerce.number().min(0.1).max(100).default(70),
  ENTRY_REQUIRE_SOL_POOL: boolDefault(true),
  ENTRY_SOL_ONLY: boolDefault(true),
  BID_ASK_RANGE_BINS: optionalNumber.pipe(z.coerce.number().int().min(69).max(1_400).optional()),
  BID_ASK_HALF_WIDTH_BINS: optionalNumber.pipe(z.coerce.number().int().min(1).max(699).optional()),
  ENTRY_SLIPPAGE_PCT: z.coerce.number().min(0).max(100).default(0.5),
  PRIORITY_FEE_MICRO_LAMPORTS: z.coerce.number().int().min(0).default(25_000),
  COMPUTE_UNIT_LIMIT: z.coerce.number().int().min(0).default(1_400_000),
  TX_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(5),
  SKIP_PREFLIGHT: boolDefault(false),
  METEORA_DATA_API_BASE: z.string().url().default("https://dlmm.datapi.meteora.ag"),
  SCANNER_PAGE_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  SCANNER_CANDIDATE_LIMIT: z.coerce.number().int().min(1).max(500).default(40),
  SCANNER_MIN_TVL_USD: z.coerce.number().min(0).default(10_000),
  SCANNER_MIN_VOLUME_24H_USD: z.coerce.number().min(0).default(50_000),
  SCANNER_REQUIRE_TOKEN_VERIFIED: boolDefault(true),
  SCANNER_ALLOW_UNVERIFIED_IF_JUPITER_PASSES: boolDefault(true),
  SCANNER_SORT_BY: z.string().default("fee_tvl_ratio_24h:desc"),
  SCANNER_DISCOVERY_SORTS: z.string().default("fee_tvl_ratio_1h:desc,fee_tvl_ratio_30m:desc,pool_created_at:desc"),
  SCANNER_DISCOVERY_MAX_POOL_AGE_HOURS: z.coerce.number().min(0.1).default(12),
  SCANNER_DISCOVERY_MIN_TVL_USD: z.coerce.number().min(0).default(5_000),
  SCANNER_DISCOVERY_MIN_VOLUME_30M_USD: z.coerce.number().min(0).default(5_000),
  SCANNER_DISCOVERY_MIN_VOLUME_1H_USD: z.coerce.number().min(0).default(10_000),
  SCANNER_DISCOVERY_MIN_FEE_TVL_RATIO_30M: z.coerce.number().min(0).default(0.35),
  SCANNER_DISCOVERY_MIN_FEE_TVL_RATIO_1H: z.coerce.number().min(0).default(0.7),
  RUGCHECK_API_BASE: z.string().url().default("https://api.rugcheck.xyz"),
  RUGCHECK_API_KEY: z.string().optional(),
  RUGCHECK_MAX_NORMALIZED_SCORE: z.coerce.number().min(0).max(100).default(45),
  RUGCHECK_FAIL_CLOSED: boolDefault(true),
  DEXSCREENER_API_BASE: z.string().url().default("https://api.dexscreener.com"),
  DEXSCREENER_ENABLED: boolDefault(true),
  JUPITER_TOKEN_API_BASE: z.string().url().default("https://lite-api.jup.ag/tokens/v2"),
  JUPITER_SWAP_API_BASE: z.string().url().default("https://lite-api.jup.ag/swap/v1"),
  JUPITER_API_KEY: z.string().optional(),
  JUPITER_ENABLED: boolDefault(true),
  JUPITER_FAIL_CLOSED: boolDefault(true),
  JUPITER_MIN_ORGANIC_SCORE: z.coerce.number().min(0).max(100).default(45),
  JUPITER_HIGH_CONFIDENCE_ORGANIC_SCORE: z.coerce.number().min(0).max(100).default(70),
  JUPITER_MIN_LIQUIDITY_USD: z.coerce.number().min(0).default(10_000),
  JUPITER_MIN_HOLDER_COUNT: z.coerce.number().int().min(0).default(100),
  JUPITER_MAX_TOP_HOLDERS_PCT: z.coerce.number().min(0).max(100).default(35),
  JUPITER_MAX_DEV_BALANCE_PCT: z.coerce.number().min(0).max(100).default(8),
  JUPITER_REQUIRE_MINT_AUTHORITY_DISABLED: boolDefault(true),
  JUPITER_REQUIRE_FREEZE_AUTHORITY_DISABLED: boolDefault(true),
  POST_EXIT_SWAP_TO_SOL: boolDefault(true),
  POST_EXIT_SWAP_MIN_USD: z.coerce.number().min(0).default(0.25),
  POST_EXIT_SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(5_000).default(150),
  POST_EXIT_SWAP_RESTRICT_INTERMEDIATE_TOKENS: boolDefault(true),
  WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  WEB_HOST: z.string().default("127.0.0.1"),
  PAPER_STATE_PATH: z.string().default("./data/paper-state.json"),
  PAPER_STARTING_BALANCE_USD: z.coerce.number().min(1).default(10_000),
  PAPER_POSITION_SIZE_USD: z.coerce.number().min(1).default(500),
  PAPER_MAX_POSITIONS: z.coerce.number().int().min(1).max(10).default(10),
  PAPER_SCAN_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  PAPER_TAKE_PROFIT_PCT: z.coerce.number().default(5),
  PAPER_STOP_LOSS_PCT: z.coerce.number().default(-12),
  PAPER_MAX_FEE_RATE_PER_HOUR_PCT: z.coerce.number().min(0).default(3)
});

const env = schema.parse(process.env);

export const config = {
  rpc: {
    url: env.RPC_URL,
    wsUrl: env.RPC_WS_URL,
    commitment: env.COMMITMENT
  },
  walletPrivateKey: env.WALLET_PRIVATE_KEY,
  autoOpen: env.AUTO_OPEN,
  positionStorePath: env.POSITION_STORE_PATH,
  maxOpenPositions: env.MAX_OPEN_POSITIONS,
  monitor: {
    intervalMs: env.MONITOR_INTERVAL_MS,
    concurrency: env.MONITOR_CONCURRENCY
  },
  entry: {
    sizingMode: env.ENTRY_SIZING_MODE,
    tokenXAmountUi: env.ENTRY_TOKEN_X_AMOUNT_UI,
    tokenYAmountUi: env.ENTRY_TOKEN_Y_AMOUNT_UI,
    walletAllocationPct: env.ENTRY_WALLET_ALLOCATION_PCT,
    reserveSolPct: env.ENTRY_RESERVE_SOL_PCT,
    minPositionSolPct: env.ENTRY_MIN_POSITION_SOL_PCT,
    maxPositionSolPct: env.ENTRY_MAX_POSITION_SOL_PCT,
    minSolReserve: env.ENTRY_MIN_SOL_RESERVE,
    minPositionSol: env.ENTRY_MIN_POSITION_SOL,
    maxPositionSol: env.ENTRY_MAX_POSITION_SOL,
    maxTotalExposurePct: env.ENTRY_MAX_TOTAL_EXPOSURE_PCT,
    requireSolPool: env.ENTRY_REQUIRE_SOL_POOL,
    solOnly: env.ENTRY_SOL_ONLY,
    rangeBins: resolveRangeBins(env.BID_ASK_RANGE_BINS, env.BID_ASK_HALF_WIDTH_BINS),
    slippagePct: env.ENTRY_SLIPPAGE_PCT,
    takeProfitPct: env.TAKE_PROFIT_PCT,
    stopLossPct: normalizeStopLossPct(env.STOP_LOSS_PCT)
  },
  tx: {
    priorityFeeMicroLamports: env.PRIORITY_FEE_MICRO_LAMPORTS,
    computeUnitLimit: env.COMPUTE_UNIT_LIMIT,
    maxRetries: env.TX_MAX_RETRIES,
    skipPreflight: env.SKIP_PREFLIGHT
  },
  scanner: {
    pageSize: env.SCANNER_PAGE_SIZE,
    candidateLimit: env.SCANNER_CANDIDATE_LIMIT,
    minTvlUsd: env.SCANNER_MIN_TVL_USD,
    minVolume24hUsd: env.SCANNER_MIN_VOLUME_24H_USD,
    requireTokenVerified: env.SCANNER_REQUIRE_TOKEN_VERIFIED,
    allowUnverifiedIfJupiterPasses: env.SCANNER_ALLOW_UNVERIFIED_IF_JUPITER_PASSES,
    sortBy: env.SCANNER_SORT_BY,
    discoverySorts: env.SCANNER_DISCOVERY_SORTS.split(",").map((item) => item.trim()).filter(Boolean),
    discoveryMaxPoolAgeHours: env.SCANNER_DISCOVERY_MAX_POOL_AGE_HOURS,
    discoveryMinTvlUsd: env.SCANNER_DISCOVERY_MIN_TVL_USD,
    discoveryMinVolume30mUsd: env.SCANNER_DISCOVERY_MIN_VOLUME_30M_USD,
    discoveryMinVolume1hUsd: env.SCANNER_DISCOVERY_MIN_VOLUME_1H_USD,
    discoveryMinFeeTvlRatio30m: env.SCANNER_DISCOVERY_MIN_FEE_TVL_RATIO_30M,
    discoveryMinFeeTvlRatio1h: env.SCANNER_DISCOVERY_MIN_FEE_TVL_RATIO_1H,
    jupiterHighConfidenceOrganicScore: env.JUPITER_HIGH_CONFIDENCE_ORGANIC_SCORE
  },
  apis: {
    meteoraDataApiBase: env.METEORA_DATA_API_BASE,
    rugCheckApiBase: env.RUGCHECK_API_BASE,
    rugCheckApiKey: env.RUGCHECK_API_KEY,
    rugCheckMaxNormalizedScore: env.RUGCHECK_MAX_NORMALIZED_SCORE,
    rugCheckFailClosed: env.RUGCHECK_FAIL_CLOSED,
    dexScreenerApiBase: env.DEXSCREENER_API_BASE,
    dexScreenerEnabled: env.DEXSCREENER_ENABLED,
    jupiterTokenApiBase: env.JUPITER_TOKEN_API_BASE,
    jupiterSwapApiBase: env.JUPITER_SWAP_API_BASE,
    jupiterApiKey: env.JUPITER_API_KEY,
    jupiterEnabled: env.JUPITER_ENABLED,
    jupiterFailClosed: env.JUPITER_FAIL_CLOSED,
    jupiterMinOrganicScore: env.JUPITER_MIN_ORGANIC_SCORE,
    jupiterHighConfidenceOrganicScore: env.JUPITER_HIGH_CONFIDENCE_ORGANIC_SCORE,
    jupiterMinLiquidityUsd: env.JUPITER_MIN_LIQUIDITY_USD,
    jupiterMinHolderCount: env.JUPITER_MIN_HOLDER_COUNT,
    jupiterMaxTopHoldersPct: env.JUPITER_MAX_TOP_HOLDERS_PCT,
    jupiterMaxDevBalancePct: env.JUPITER_MAX_DEV_BALANCE_PCT,
    jupiterRequireMintAuthorityDisabled: env.JUPITER_REQUIRE_MINT_AUTHORITY_DISABLED,
    jupiterRequireFreezeAuthorityDisabled: env.JUPITER_REQUIRE_FREEZE_AUTHORITY_DISABLED
  },
  postExitSwap: {
    enabled: env.POST_EXIT_SWAP_TO_SOL,
    minSwapUsd: env.POST_EXIT_SWAP_MIN_USD,
    slippageBps: env.POST_EXIT_SWAP_SLIPPAGE_BPS,
    restrictIntermediateTokens: env.POST_EXIT_SWAP_RESTRICT_INTERMEDIATE_TOKENS
  },
  web: {
    port: env.WEB_PORT,
    host: env.WEB_HOST
  },
  paper: {
    statePath: env.PAPER_STATE_PATH,
    startingBalanceUsd: env.PAPER_STARTING_BALANCE_USD,
    positionSizeUsd: env.PAPER_POSITION_SIZE_USD,
    maxPositions: env.PAPER_MAX_POSITIONS,
    scanIntervalMs: env.PAPER_SCAN_INTERVAL_MS,
    takeProfitPct: env.PAPER_TAKE_PROFIT_PCT,
    stopLossPct: normalizeStopLossPct(env.PAPER_STOP_LOSS_PCT),
    maxFeeRatePerHourPct: env.PAPER_MAX_FEE_RATE_PER_HOUR_PCT
  }
} as const;
