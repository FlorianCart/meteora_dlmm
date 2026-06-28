import { Keypair, PublicKey } from "@solana/web3.js";
import { Decimal } from "decimal.js";
import { decimalFromRaw, toFiniteNumber } from "../utils/decimal.js";
import { logger } from "../utils/logger.js";
import { type ManagedPositionState, type TokenMetrics, SOL_MINT } from "../types.js";
import { JupiterSwapService, type SwapResult } from "./JupiterSwapService.js";
import { RpcService } from "./RpcService.js";

export interface PostExitSwapOptions {
  enabled: boolean;
  minSwapUsd: number;
}

export class PostExitSwapService {
  constructor(
    private readonly rpc: RpcService,
    private readonly jupiter: JupiterSwapService,
    private readonly options: PostExitSwapOptions
  ) {}

  async sweepPositionTokensToSol(position: ManagedPositionState, owner: Keypair): Promise<SwapResult[]> {
    if (!this.options.enabled) {
      return [];
    }

    const results: SwapResult[] = [];
    for (const token of [position.tokenX, position.tokenY]) {
      const result = await this.sweepTokenToSol(token, position, owner);
      if (result) {
        results.push(result);
      }
    }
    return results;
  }

  async sweepTrackedTokensToSol(positions: ManagedPositionState[], owner: Keypair): Promise<SwapResult[]> {
    if (!this.options.enabled) {
      return [];
    }

    const tokenByMint = new Map<string, { token: TokenMetrics; position: ManagedPositionState }>();
    for (const position of positions) {
      for (const token of [position.tokenX, position.tokenY]) {
        if (token.address !== SOL_MINT && !tokenByMint.has(token.address)) {
          tokenByMint.set(token.address, { token, position });
        }
      }
    }

    const results: SwapResult[] = [];
    for (const { token, position } of tokenByMint.values()) {
      const result = await this.sweepTokenToSol(token, position, owner);
      if (result) {
        results.push(result);
      }
    }
    return results;
  }

  private async sweepTokenToSol(
    token: TokenMetrics,
    position: ManagedPositionState,
    owner: Keypair
  ): Promise<SwapResult | null> {
    if (token.address === SOL_MINT) {
      return null;
    }

    const amountRaw = await this.walletTokenBalanceRaw(owner.publicKey, token.address);
    if (amountRaw <= 0n) {
      return null;
    }

    const estimatedUsd = this.estimatedUsd(token, amountRaw, position);
    if (estimatedUsd < this.options.minSwapUsd) {
      logger.info(
        {
          mint: token.address,
          symbol: token.symbol,
          amountRaw: amountRaw.toString(),
          estimatedUsd
        },
        "Skipping tiny post-exit swap"
      );
      return null;
    }

    logger.warn(
      {
        mint: token.address,
        symbol: token.symbol,
        amountRaw: amountRaw.toString(),
        estimatedUsd
      },
      "Swapping post-exit token balance to SOL"
    );
    const result = await this.jupiter.swapExactInToSol(token.address, amountRaw.toString(), owner);
    logger.info(
      {
        mint: token.address,
        symbol: token.symbol,
        inAmount: result.inAmount,
        outAmount: result.outAmount,
        priceImpactPct: result.priceImpactPct,
        signature: result.signature
      },
      "Post-exit swap to SOL complete"
    );
    return result;
  }

  private async walletTokenBalanceRaw(owner: PublicKey, mint: string): Promise<bigint> {
    const accounts = await this.rpc.connection.getParsedTokenAccountsByOwner(owner, {
      mint: new PublicKey(mint)
    });
    return accounts.value.reduce((sum, item) => {
      const parsed = item.account.data.parsed as {
        info?: {
          tokenAmount?: {
            amount?: string;
          };
        };
      };
      const amount = parsed.info?.tokenAmount?.amount ?? "0";
      return sum + BigInt(amount);
    }, 0n);
  }

  private estimatedUsd(token: TokenMetrics, amountRaw: bigint, position: ManagedPositionState): number {
    const price =
      token.address === position.tokenX.address
        ? position.lastSnapshot?.tokenXPriceUsd ?? position.entryTokenXPriceUsd
        : position.lastSnapshot?.tokenYPriceUsd ?? position.entryTokenYPriceUsd;
    const value = decimalFromRaw(amountRaw.toString(), token.decimals).mul(new Decimal(price));
    return toFiniteNumber(value);
  }
}
