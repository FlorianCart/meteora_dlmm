import type { DexScreenerPair, TokenDexSummary } from "../types.js";
import { HttpClient } from "./HttpClient.js";

export class DexScreenerApi {
  constructor(private readonly http: HttpClient) {}

  getTokenPairs(mint: string): Promise<DexScreenerPair[]> {
    return this.http.getJson<DexScreenerPair[]>(`/token-pairs/v1/solana/${mint}`);
  }

  async summarizeToken(mint: string): Promise<TokenDexSummary> {
    const pairs = await this.getTokenPairs(mint);
    return pairs
      .filter((pair) => pair.chainId === "solana")
      .reduce<TokenDexSummary>(
        (acc, pair) => ({
          mint,
          totalLiquidityUsd: acc.totalLiquidityUsd + (pair.liquidity?.usd ?? 0),
          totalVolume24hUsd: acc.totalVolume24hUsd + (pair.volume?.h24 ?? 0),
          pairCount: acc.pairCount + 1
        }),
        { mint, totalLiquidityUsd: 0, totalVolume24hUsd: 0, pairCount: 0 }
      );
  }
}
