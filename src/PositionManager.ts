import { Keypair, PublicKey } from "@solana/web3.js";
import type { ManagedPositionState, MeteoraPool, ProfitSnapshot } from "./types.js";
import { MeteoraDlmmClient } from "./dlmm/MeteoraDlmmClient.js";
import { PositionStore } from "./state/PositionStore.js";
import { PositionValuator } from "./valuation/PositionValuator.js";
import { rawFromUi, toFiniteNumber, usdValue } from "./utils/decimal.js";
import { nowIso } from "./utils/time.js";

interface OpenManagedPositionParams {
  pool: MeteoraPool;
  owner: Keypair;
  amountXUi: string;
  amountYUi: string;
  halfWidthBins: number;
  slippagePct: number;
  takeProfitPct: number;
  stopLossPct: number;
  autoFillBalancedAmounts?: boolean;
  singleSidedX?: boolean;
}

export class PositionManager {
  constructor(
    private readonly store: PositionStore,
    private readonly dlmm: MeteoraDlmmClient,
    private readonly valuator: PositionValuator,
    private readonly maxOpenPositions: number
  ) {}

  async open(params: OpenManagedPositionParams): Promise<ManagedPositionState> {
    const activeCount = this.store.listActive().length;
    if (activeCount >= this.maxOpenPositions) {
      throw new Error(`Max active positions reached: ${activeCount}/${this.maxOpenPositions}`);
    }

    const amountXRaw = rawFromUi(params.amountXUi, params.pool.token_x.decimals);
    const amountYRaw = rawFromUi(params.amountYUi, params.pool.token_y.decimals);
    const opened = await this.dlmm.openBidAskPosition(
      {
        pool: params.pool,
        owner: params.owner.publicKey.toBase58(),
        amountXRaw: amountXRaw.toString(),
        amountYRaw: amountYRaw.toString(),
        halfWidthBins: params.halfWidthBins,
        slippagePct: params.slippagePct,
        takeProfitPct: params.takeProfitPct,
        stopLossPct: params.stopLossPct,
        ...(params.autoFillBalancedAmounts !== undefined
          ? { autoFillBalancedAmounts: params.autoFillBalancedAmounts }
          : {}),
        ...(params.singleSidedX !== undefined ? { singleSidedX: params.singleSidedX } : {})
      },
      params.owner
    );

    const entryValueUsd = usdValue(opened.amountXRaw, params.pool.token_x.decimals, params.pool.token_x.price).plus(
      usdValue(opened.amountYRaw, params.pool.token_y.decimals, params.pool.token_y.price)
    );

    const state: ManagedPositionState = {
      id: opened.positionAddress,
      poolAddress: params.pool.address,
      positionAddress: opened.positionAddress,
      owner: params.owner.publicKey.toBase58(),
      status: "OPEN",
      tokenX: params.pool.token_x,
      tokenY: params.pool.token_y,
      lowerBinId: opened.lowerBinId,
      upperBinId: opened.upperBinId,
      entryActiveBinId: opened.activeBinId,
      entryTx: opened.txSignature,
      openedAt: nowIso(),
      entryValueUsd: toFiniteNumber(entryValueUsd),
      entryXRaw: opened.amountXRaw,
      entryYRaw: opened.amountYRaw,
      entryTokenXPriceUsd: params.pool.token_x.price,
      entryTokenYPriceUsd: params.pool.token_y.price,
      takeProfitPct: params.takeProfitPct,
      stopLossPct: params.stopLossPct,
      claimedFeeValueUsd: 0,
      errorCount: 0
    };

    await this.store.upsert(state);
    return state;
  }

  async evaluate(position: ManagedPositionState): Promise<ProfitSnapshot> {
    const owner = new PublicKey(position.owner);
    const { activeBinId, position: onChainPosition } = await this.dlmm.getPosition(
      position.poolAddress,
      owner,
      position.positionAddress
    );
    return this.valuator.snapshot(onChainPosition, position, activeBinId);
  }

  exit(position: ManagedPositionState, owner: Keypair): Promise<string[]> {
    if (position.owner !== owner.publicKey.toBase58()) {
      throw new Error(`Wallet ${owner.publicKey.toBase58()} does not own position ${position.positionAddress}`);
    }
    return this.dlmm.removeAllAndClaim(position.poolAddress, owner, position.positionAddress);
  }
}
