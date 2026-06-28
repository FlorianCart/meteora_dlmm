import { Decimal } from "decimal.js";
import { BN } from "@coral-xyz/anchor";

export function decimalFromRaw(raw: string | number | bigint | BN, decimals: number): Decimal {
  const value = BN.isBN(raw) ? raw.toString() : raw.toString();
  return new Decimal(value).div(new Decimal(10).pow(decimals));
}

export function rawFromUi(uiAmount: string | number, decimals: number): BN {
  const raw = new Decimal(uiAmount).mul(new Decimal(10).pow(decimals)).floor();
  if (raw.isNegative()) {
    throw new Error(`Negative token amount is invalid: ${uiAmount}`);
  }
  return new BN(raw.toFixed(0));
}

export function toFiniteNumber(value: Decimal): number {
  const n = value.toNumber();
  if (!Number.isFinite(n)) {
    throw new Error(`Non-finite decimal value: ${value.toString()}`);
  }
  return n;
}

export function usdValue(raw: string | number | bigint | BN, decimals: number, priceUsd: number): Decimal {
  return decimalFromRaw(raw, decimals).mul(priceUsd);
}
