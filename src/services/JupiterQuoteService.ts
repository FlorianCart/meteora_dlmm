import { Decimal } from "decimal.js";
import { SOL_MINT, USDC_MINT } from "../types.js";
import { decimalFromRaw, rawFromUi, toFiniteNumber } from "../utils/decimal.js";
import { HttpClient } from "./HttpClient.js";

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const SOL_PRICE_CACHE_MS = 15_000;

export interface JupiterQuoteServiceOptions {
  slippageBps: number;
  restrictIntermediateTokens: boolean;
}

export interface JupiterQuoteResult {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

export class JupiterQuoteService {
  private solUsdPriceCache: { price: Decimal; expiresAt: number } | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly options: JupiterQuoteServiceOptions
  ) {}

  async quoteExactIn(inputMint: string, outputMint: string, amountRaw: string): Promise<JupiterQuoteResult> {
    if (BigInt(amountRaw) <= 0n) {
      return {
        inputMint,
        outputMint,
        inAmount: "0",
        outAmount: "0",
        priceImpactPct: "0",
        routePlan: []
      };
    }

    if (inputMint === outputMint) {
      return {
        inputMint,
        outputMint,
        inAmount: amountRaw,
        outAmount: amountRaw,
        priceImpactPct: "0",
        routePlan: []
      };
    }

    return this.http.getJson<JupiterQuoteResult>("quote", {
      query: {
        inputMint,
        outputMint,
        amount: amountRaw,
        slippageBps: this.options.slippageBps,
        swapMode: "ExactIn",
        restrictIntermediateTokens: this.options.restrictIntermediateTokens,
        instructionVersion: "V2"
      }
    });
  }

  async quoteToSol(inputMint: string, amountRaw: string): Promise<Decimal> {
    if (BigInt(amountRaw) <= 0n) {
      return new Decimal(0);
    }

    if (inputMint === SOL_MINT) {
      return decimalFromRaw(amountRaw, SOL_DECIMALS);
    }

    const quote = await this.quoteExactIn(inputMint, SOL_MINT, amountRaw);
    if (quote.routePlan.length === 0) {
      throw new Error(`Jupiter returned no route for ${inputMint} -> SOL.`);
    }
    return decimalFromRaw(quote.outAmount, SOL_DECIMALS);
  }

  async solUsdPrice(): Promise<Decimal> {
    const now = Date.now();
    if (this.solUsdPriceCache && this.solUsdPriceCache.expiresAt > now) {
      return this.solUsdPriceCache.price;
    }

    const oneSolRaw = rawFromUi("1", SOL_DECIMALS).toString();
    const quote = await this.quoteExactIn(SOL_MINT, USDC_MINT, oneSolRaw);
    if (quote.routePlan.length === 0) {
      throw new Error("Jupiter returned no route for SOL -> USDC.");
    }

    const price = decimalFromRaw(quote.outAmount, USDC_DECIMALS);
    this.solUsdPriceCache = {
      price,
      expiresAt: now + SOL_PRICE_CACHE_MS
    };
    return price;
  }

  async valueToUsd(inputMint: string, amountRaw: string): Promise<Decimal> {
    const [amountSol, solUsdPrice] = await Promise.all([this.quoteToSol(inputMint, amountRaw), this.solUsdPrice()]);
    return amountSol.mul(solUsdPrice);
  }

  async valueToUsdNumber(inputMint: string, amountRaw: string): Promise<number> {
    return toFiniteNumber(await this.valueToUsd(inputMint, amountRaw));
  }
}
