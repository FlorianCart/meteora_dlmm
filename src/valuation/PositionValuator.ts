import { BN } from "@coral-xyz/anchor";
import type { LbPosition } from "@meteora-ag/dlmm";
import { Decimal } from "decimal.js";
import { SOL_MINT, type ManagedPositionState, type ProfitSnapshot, type TokenMetrics } from "../types.js";
import { MeteoraDataApi } from "../services/MeteoraDataApi.js";
import { JupiterQuoteService } from "../services/JupiterQuoteService.js";
import { decimalFromRaw, toFiniteNumber, usdValue } from "../utils/decimal.js";
import { logger } from "../utils/logger.js";
import { nowIso } from "../utils/time.js";

export class PositionValuator {
  constructor(
    private readonly meteoraData: MeteoraDataApi,
    private readonly jupiterQuotes: JupiterQuoteService | null = null
  ) {}

  async snapshot(position: LbPosition, tracked: ManagedPositionState, activeBinId: number): Promise<ProfitSnapshot> {
    const pool = await this.meteoraData.getPool(tracked.poolAddress);
    const liquidityXRaw = new BN(position.positionData.totalXAmount);
    const liquidityYRaw = new BN(position.positionData.totalYAmount);
    const feeXRaw = bnOrZero(position.positionData.feeXExcludeTransferFee ?? position.positionData.feeX);
    const feeYRaw = bnOrZero(position.positionData.feeYExcludeTransferFee ?? position.positionData.feeY);

    if (this.jupiterQuotes) {
      try {
        return await this.jupiterExitQuoteSnapshot({
          tracked,
          activeBinId,
          tokenXFallbackPriceUsd: pool.token_x.price,
          tokenYFallbackPriceUsd: pool.token_y.price,
          liquidityXRaw,
          liquidityYRaw,
          feeXRaw,
          feeYRaw
        });
      } catch (error) {
        logger.warn(
          {
            position: tracked.positionAddress,
            pool: tracked.poolAddress,
            error: error instanceof Error ? error.message : String(error)
          },
          "Jupiter exit quote valuation failed; falling back to Meteora price valuation"
        );
      }
    }

    const tokenXPriceUsd = pool.token_x.price;
    const tokenYPriceUsd = pool.token_y.price;
    const liquidityValueUsd = usdValue(liquidityXRaw, tracked.tokenX.decimals, tokenXPriceUsd).plus(
      usdValue(liquidityYRaw, tracked.tokenY.decimals, tokenYPriceUsd)
    );
    const feeValueUsd = usdValue(feeXRaw, tracked.tokenX.decimals, tokenXPriceUsd).plus(
      usdValue(feeYRaw, tracked.tokenY.decimals, tokenYPriceUsd)
    );
    const currentValueUsd = liquidityValueUsd.plus(feeValueUsd).plus(tracked.claimedFeeValueUsd);
    const hodlValueUsd = usdValue(tracked.entryXRaw, tracked.tokenX.decimals, tokenXPriceUsd).plus(
      usdValue(tracked.entryYRaw, tracked.tokenY.decimals, tokenYPriceUsd)
    );
    const entryValueUsd = new Decimal(tracked.entryValueUsd);
    const profitUsd = currentValueUsd.minus(entryValueUsd);
    const impermanentLossUsd = liquidityValueUsd.minus(hodlValueUsd);

    return {
      timestamp: nowIso(),
      valuationSource: "meteora-data-api",
      activeBinId,
      tokenXPriceUsd,
      tokenYPriceUsd,
      liquidityXRaw: liquidityXRaw.toString(),
      liquidityYRaw: liquidityYRaw.toString(),
      feeXRaw: feeXRaw.toString(),
      feeYRaw: feeYRaw.toString(),
      liquidityValueUsd: toFiniteNumber(liquidityValueUsd),
      feeValueUsd: toFiniteNumber(feeValueUsd),
      claimedFeeValueUsd: tracked.claimedFeeValueUsd,
      currentValueUsd: toFiniteNumber(currentValueUsd),
      hodlValueUsd: toFiniteNumber(hodlValueUsd),
      impermanentLossUsd: toFiniteNumber(impermanentLossUsd),
      profitUsd: toFiniteNumber(profitUsd),
      profitPct: percent(profitUsd, entryValueUsd),
      feeYieldPct: percent(feeValueUsd, entryValueUsd),
      vsHodlPct: percent(currentValueUsd.minus(hodlValueUsd), hodlValueUsd)
    };
  }

  private async jupiterExitQuoteSnapshot(params: {
    tracked: ManagedPositionState;
    activeBinId: number;
    tokenXFallbackPriceUsd: number;
    tokenYFallbackPriceUsd: number;
    liquidityXRaw: BN;
    liquidityYRaw: BN;
    feeXRaw: BN;
    feeYRaw: BN;
  }): Promise<ProfitSnapshot> {
    if (!this.jupiterQuotes) {
      throw new Error("Jupiter quote service is not configured.");
    }

    const solPriceUsd = await this.jupiterQuotes.solUsdPrice();
    const [tokenXValue, tokenYValue] = await Promise.all([
      this.quoteTokenValue(
        params.tracked.tokenX,
        params.liquidityXRaw,
        params.feeXRaw,
        solPriceUsd,
        params.tokenXFallbackPriceUsd
      ),
      this.quoteTokenValue(
        params.tracked.tokenY,
        params.liquidityYRaw,
        params.feeYRaw,
        solPriceUsd,
        params.tokenYFallbackPriceUsd
      )
    ]);

    const liquidityValueUsd = tokenXValue.liquidityUsd.plus(tokenYValue.liquidityUsd);
    const feeValueUsd = tokenXValue.feeUsd.plus(tokenYValue.feeUsd);
    const currentValueUsd = liquidityValueUsd.plus(feeValueUsd).plus(params.tracked.claimedFeeValueUsd);
    const liquidityValueSol = tokenXValue.liquiditySol.plus(tokenYValue.liquiditySol);
    const feeValueSol = tokenXValue.feeSol.plus(tokenYValue.feeSol);
    const currentValueSol = liquidityValueSol.plus(feeValueSol);
    const hodlValueUsd = await this.quoteHodlValueUsd(params.tracked, solPriceUsd);
    const entryValueUsd = new Decimal(params.tracked.entryValueUsd);
    const profitUsd = currentValueUsd.minus(entryValueUsd);
    const impermanentLossUsd = liquidityValueUsd.minus(hodlValueUsd);
    const exactEntryValueSol = exactSolOnlyEntryValue(params.tracked);
    const profitSol = exactEntryValueSol ? currentValueSol.minus(exactEntryValueSol) : null;

    return {
      timestamp: nowIso(),
      valuationSource: "jupiter-exit-quote",
      activeBinId: params.activeBinId,
      tokenXPriceUsd: toFiniteNumber(tokenXValue.priceUsd),
      tokenYPriceUsd: toFiniteNumber(tokenYValue.priceUsd),
      solPriceUsd: toFiniteNumber(solPriceUsd),
      liquidityXRaw: params.liquidityXRaw.toString(),
      liquidityYRaw: params.liquidityYRaw.toString(),
      feeXRaw: params.feeXRaw.toString(),
      feeYRaw: params.feeYRaw.toString(),
      liquidityValueSol: toFiniteNumber(liquidityValueSol),
      feeValueSol: toFiniteNumber(feeValueSol),
      currentValueSol: toFiniteNumber(currentValueSol),
      ...(exactEntryValueSol
        ? {
            entryValueSol: toFiniteNumber(exactEntryValueSol),
            ...(profitSol ? { profitSol: toFiniteNumber(profitSol) } : {})
          }
        : {}),
      liquidityValueUsd: toFiniteNumber(liquidityValueUsd),
      feeValueUsd: toFiniteNumber(feeValueUsd),
      claimedFeeValueUsd: params.tracked.claimedFeeValueUsd,
      currentValueUsd: toFiniteNumber(currentValueUsd),
      hodlValueUsd: toFiniteNumber(hodlValueUsd),
      impermanentLossUsd: toFiniteNumber(impermanentLossUsd),
      profitUsd: toFiniteNumber(profitUsd),
      profitPct: percent(profitUsd, entryValueUsd),
      feeYieldPct: percent(feeValueUsd, entryValueUsd),
      vsHodlPct: percent(currentValueUsd.minus(hodlValueUsd), hodlValueUsd)
    };
  }

  private async quoteTokenValue(
    token: TokenMetrics,
    liquidityRaw: BN,
    feeRaw: BN,
    solPriceUsd: Decimal,
    fallbackPriceUsd: number
  ): Promise<{
    liquiditySol: Decimal;
    feeSol: Decimal;
    liquidityUsd: Decimal;
    feeUsd: Decimal;
    priceUsd: Decimal;
  }> {
    const totalRaw = liquidityRaw.add(feeRaw);
    if (totalRaw.isZero()) {
      return {
        liquiditySol: new Decimal(0),
        feeSol: new Decimal(0),
        liquidityUsd: new Decimal(0),
        feeUsd: new Decimal(0),
        priceUsd: new Decimal(fallbackPriceUsd)
      };
    }

    const totalSol = await this.requireJupiterQuotes().quoteToSol(token.address, totalRaw.toString());
    const totalUsd = totalSol.mul(solPriceUsd);
    const totalRawDecimal = new Decimal(totalRaw.toString());
    const liquidityRatio = new Decimal(liquidityRaw.toString()).div(totalRawDecimal);
    const feeRatio = new Decimal(feeRaw.toString()).div(totalRawDecimal);
    const totalUi = decimalFromRaw(totalRaw, token.decimals);

    return {
      liquiditySol: totalSol.mul(liquidityRatio),
      feeSol: totalSol.mul(feeRatio),
      liquidityUsd: totalUsd.mul(liquidityRatio),
      feeUsd: totalUsd.mul(feeRatio),
      priceUsd: totalUi.isZero() ? new Decimal(fallbackPriceUsd) : totalUsd.div(totalUi)
    };
  }

  private async quoteHodlValueUsd(tracked: ManagedPositionState, solPriceUsd: Decimal): Promise<Decimal> {
    const [entryXSol, entryYSol] = await Promise.all([
      this.requireJupiterQuotes().quoteToSol(tracked.tokenX.address, tracked.entryXRaw),
      this.requireJupiterQuotes().quoteToSol(tracked.tokenY.address, tracked.entryYRaw)
    ]);
    return entryXSol.plus(entryYSol).mul(solPriceUsd);
  }

  private requireJupiterQuotes(): JupiterQuoteService {
    if (!this.jupiterQuotes) {
      throw new Error("Jupiter quote service is not configured.");
    }
    return this.jupiterQuotes;
  }
}

function bnOrZero(value: BN | string | number | null | undefined): BN {
  if (value === null || value === undefined) {
    return new BN(0);
  }
  return BN.isBN(value) ? value : new BN(value);
}

function percent(numerator: Decimal, denominator: Decimal): number {
  if (denominator.isZero()) {
    return 0;
  }
  return toFiniteNumber(numerator.div(denominator).mul(100));
}

function exactSolOnlyEntryValue(tracked: ManagedPositionState): Decimal | null {
  const entryXRaw = new BN(tracked.entryXRaw);
  const entryYRaw = new BN(tracked.entryYRaw);
  let entrySol = new Decimal(0);

  if (tracked.tokenX.address === SOL_MINT) {
    entrySol = entrySol.plus(decimalFromRaw(entryXRaw, tracked.tokenX.decimals));
  } else if (!entryXRaw.isZero()) {
    return null;
  }

  if (tracked.tokenY.address === SOL_MINT) {
    entrySol = entrySol.plus(decimalFromRaw(entryYRaw, tracked.tokenY.decimals));
  } else if (!entryYRaw.isZero()) {
    return null;
  }

  return entrySol;
}
