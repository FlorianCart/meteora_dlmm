export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4wM3ryrEAw2XfLxeNTHfh";

export type TimeWindow = "30m" | "1h" | "2h" | "4h" | "12h" | "24h";

export interface TimeWindowData {
  "30m": number;
  "1h": number;
  "2h": number;
  "4h": number;
  "12h": number;
  "24h": number;
}

export interface TokenMetrics {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  is_verified: boolean;
  holders: number;
  freeze_authority_disabled: boolean;
  total_supply: number;
  price: number;
  market_cap: number;
}

export interface PoolConfig {
  bin_step: number;
  base_fee_pct: number;
  max_fee_pct: number;
  protocol_fee_pct: number;
  collect_fee_mode: number;
}

export interface MeteoraPool {
  address: string;
  name: string;
  token_x: TokenMetrics;
  token_y: TokenMetrics;
  reserve_x: string;
  reserve_y: string;
  token_x_amount: number;
  token_y_amount: number;
  created_at: number;
  reward_mint_x: string;
  reward_mint_y: string;
  pool_config: PoolConfig;
  dynamic_fee_pct: number;
  tvl: number;
  current_price: number;
  apr: number;
  apy: number;
  has_farm: boolean;
  farm_apr: number;
  farm_apy: number;
  volume: TimeWindowData;
  fees: TimeWindowData;
  protocol_fees: TimeWindowData;
  fee_tvl_ratio: TimeWindowData;
  cumulative_metrics: {
    volume: number;
    fees: number;
  };
  is_blacklisted: boolean;
  launchpad?: string | null;
  tags: string[];
}

export interface MeteoraPoolsResponse {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: MeteoraPool[];
}

export interface RugRisk {
  name: string;
  level: string;
  score: number;
  description?: string;
  value?: string;
}

export interface RugCheckSummary {
  tokenProgram?: string;
  tokenType?: string;
  risks?: RugRisk[];
  score?: number;
  score_normalised?: number;
  lpLockedPct?: number;
}

export interface RiskAssessment {
  mint: string;
  score: number | null;
  scoreNormalized: number | null;
  isDangerous: boolean;
  reasons: string[];
  raw?: RugCheckSummary;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url?: string;
  baseToken?: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken?: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd?: string;
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  volume?: {
    h24?: number;
    h6?: number;
    h1?: number;
    m5?: number;
  };
  txns?: Record<string, { buys: number; sells: number }>;
  pairCreatedAt?: number;
}

export interface TokenDexSummary {
  mint: string;
  totalLiquidityUsd: number;
  totalVolume24hUsd: number;
  pairCount: number;
}

export interface JupiterSwapStats {
  priceChange?: number | null;
  holderChange?: number | null;
  liquidityChange?: number | null;
  volumeChange?: number | null;
  buyVolume?: number | null;
  sellVolume?: number | null;
  buyOrganicVolume?: number | null;
  sellOrganicVolume?: number | null;
  numBuys?: number | null;
  numSells?: number | null;
  numTraders?: number | null;
  numOrganicBuyers?: number | null;
  numNetBuyers?: number | null;
}

export interface JupiterAudit {
  isSus?: boolean | null;
  mintAuthorityDisabled?: boolean | null;
  freezeAuthorityDisabled?: boolean | null;
  topHoldersPercentage?: number | null;
  devBalancePercentage?: number | null;
  devMints?: number | null;
}

export interface JupiterTokenInfo {
  id: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  tokenProgram?: string;
  firstPool?: {
    id?: string;
    createdAt?: string;
  } | null;
  holderCount?: number | null;
  audit?: JupiterAudit | null;
  organicScore?: number | null;
  organicScoreLabel?: "high" | "medium" | "low" | string | null;
  isVerified?: boolean | null;
  tags?: string[] | null;
  fdv?: number | null;
  mcap?: number | null;
  usdPrice?: number | null;
  liquidity?: number | null;
  stats5m?: JupiterSwapStats | null;
  stats1h?: JupiterSwapStats | null;
  stats6h?: JupiterSwapStats | null;
  stats24h?: JupiterSwapStats | null;
  updatedAt?: string | null;
}

export interface JupiterAssessment {
  mint: string;
  found: boolean;
  isDangerous: boolean;
  isVerified: boolean | null;
  organicScore: number | null;
  organicScoreLabel: string | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  topHoldersPercentage: number | null;
  organicVolume1hUsd: number;
  organicBuyers1h: number;
  reasons: string[];
  raw?: JupiterTokenInfo;
}

export interface PoolScoreBreakdown {
  shortHorizonFeeScore: number;
  recencyScore: number;
  feeTvlScore: number;
  volumeTvlScore: number;
  tvlScore: number;
  verificationScore: number;
  dexConfirmationScore: number;
  jupiterOrganicScore: number;
  binStepPenalty: number;
  riskPenalty: number;
  jupiterPenalty: number;
}

export interface ScoredPool {
  pool: MeteoraPool;
  score: number;
  eligible: boolean;
  reasons: string[];
  risk: RiskAssessment[];
  jupiter: JupiterAssessment[];
  dex: TokenDexSummary[];
  breakdown: PoolScoreBreakdown;
}

export type PositionStatus = "OPEN" | "EXITING" | "CLOSED" | "ERROR";
export type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL" | "OUT_OF_RANGE_UP";
export type OutOfRangeDirection = "ABOVE" | "BELOW";

export interface ProfitSnapshot {
  timestamp: string;
  valuationSource?: "meteora-data-api" | "jupiter-exit-quote";
  activeBinId: number;
  tokenXPriceUsd: number;
  tokenYPriceUsd: number;
  solPriceUsd?: number;
  liquidityXRaw: string;
  liquidityYRaw: string;
  feeXRaw: string;
  feeYRaw: string;
  liquidityValueSol?: number;
  feeValueSol?: number;
  currentValueSol?: number;
  entryValueSol?: number;
  profitSol?: number;
  liquidityValueUsd: number;
  feeValueUsd: number;
  claimedFeeValueUsd: number;
  currentValueUsd: number;
  hodlValueUsd: number;
  impermanentLossUsd: number;
  profitUsd: number;
  profitPct: number;
  feeYieldPct: number;
  vsHodlPct: number;
}

export interface ManagedPositionState {
  id: string;
  poolAddress: string;
  positionAddress: string;
  owner: string;
  status: PositionStatus;
  tokenX: TokenMetrics;
  tokenY: TokenMetrics;
  lowerBinId: number;
  upperBinId: number;
  entryActiveBinId: number;
  entryTx: string;
  openedAt: string;
  entryValueUsd: number;
  entryXRaw: string;
  entryYRaw: string;
  entryTokenXPriceUsd: number;
  entryTokenYPriceUsd: number;
  takeProfitPct: number;
  stopLossPct: number;
  claimedFeeValueUsd: number;
  lastSnapshot?: ProfitSnapshot;
  errorCount: number;
  lastError?: string;
  outOfRangeSince?: string;
  outOfRangeDirection?: OutOfRangeDirection;
  exitReason?: ExitReason;
  exitTxs?: string[];
  closedAt?: string;
}

export interface OpenPositionRequest {
  pool: MeteoraPool;
  owner: string;
  amountXRaw: string;
  amountYRaw: string;
  rangeBins: number;
  slippagePct: number;
  takeProfitPct: number;
  stopLossPct: number;
  autoFillBalancedAmounts?: boolean;
  singleSidedX?: boolean;
}

export interface OpenedPositionResult {
  positionAddress: string;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  txSignature: string;
  amountXRaw: string;
  amountYRaw: string;
}
