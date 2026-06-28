import { BN } from "@coral-xyz/anchor";
import type { LbPosition } from "@meteora-ag/dlmm";
import { Decimal } from "decimal.js";
import type { ManagedPositionState, ProfitSnapshot } from "../types.js";
import { MeteoraDataApi } from "../services/MeteoraDataApi.js";
import { toFiniteNumber, usdValue } from "../utils/decimal.js";
import { nowIso } from "../utils/time.js";

export class PositionValuator {
  constructor(private readonly meteoraData: MeteoraDataApi) {}

  async snapshot(position: LbPosition, tracked: ManagedPositionState, activeBinId: number): Promise<ProfitSnapshot> {
    const pool = await this.meteoraData.getPool(tracked.poolAddress);
    const tokenXPriceUsd = pool.token_x.price;
    const tokenYPriceUsd = pool.token_y.price;
    const liquidityXRaw = new BN(position.positionData.totalXAmount);
    const liquidityYRaw = new BN(position.positionData.totalYAmount);
    const feeXRaw = bnOrZero(position.positionData.feeXExcludeTransferFee ?? position.positionData.feeX);
    const feeYRaw = bnOrZero(position.positionData.feeYExcludeTransferFee ?? position.positionData.feeY);

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
