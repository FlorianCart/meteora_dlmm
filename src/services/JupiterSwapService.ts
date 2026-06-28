import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { HttpClient } from "./HttpClient.js";
import { RpcService } from "./RpcService.js";
import { SOL_MINT } from "../types.js";

export interface JupiterSwapServiceOptions {
  slippageBps: number;
  restrictIntermediateTokens: boolean;
}

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

interface JupiterSwapResponse {
  swapTransaction: string;
}

export interface SwapResult {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  signature: string;
}

export class JupiterSwapService {
  constructor(
    private readonly http: HttpClient,
    private readonly rpc: RpcService,
    private readonly options: JupiterSwapServiceOptions
  ) {}

  async swapExactInToSol(inputMint: string, amountRaw: string, owner: Keypair): Promise<SwapResult> {
    if (inputMint === SOL_MINT) {
      throw new Error("Refusing to swap SOL to SOL.");
    }
    if (BigInt(amountRaw) <= 0n) {
      throw new Error(`Swap amount must be positive for ${inputMint}.`);
    }

    const quote = await this.quote(inputMint, amountRaw);
    if (quote.routePlan.length === 0) {
      throw new Error(`Jupiter returned no route for ${inputMint} -> SOL.`);
    }

    const swap = await this.http.postJson<JupiterSwapResponse>("swap", {
      body: {
        quoteResponse: quote,
        userPublicKey: owner.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true
      }
    });

    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
    const signature = await this.rpc.sendVersionedTransaction(tx, [owner], `swap ${inputMint} to SOL`);

    return {
      inputMint,
      outputMint: SOL_MINT,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
      signature
    };
  }

  private quote(inputMint: string, amountRaw: string): Promise<JupiterQuoteResponse> {
    return this.http.getJson<JupiterQuoteResponse>("quote", {
      query: {
        inputMint,
        outputMint: SOL_MINT,
        amount: amountRaw,
        slippageBps: this.options.slippageBps,
        swapMode: "ExactIn",
        restrictIntermediateTokens: this.options.restrictIntermediateTokens,
        instructionVersion: "V2"
      }
    });
  }
}
