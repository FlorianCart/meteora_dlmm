import { BN } from "@coral-xyz/anchor";
import DLMM, {
  autoFillXByStrategy,
  autoFillYByStrategy,
  BASIS_POINT_MAX,
  getPositionLowerUpperBinIdWithLiquidity,
  StrategyType,
  type LbPosition
} from "@meteora-ag/dlmm";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { OpenedPositionResult, OpenPositionRequest } from "../types.js";
import { RpcService } from "../services/RpcService.js";
import { logger } from "../utils/logger.js";

export class MeteoraDlmmClient {
  private readonly clients = new Map<string, Promise<DLMM>>();

  constructor(private readonly rpc: RpcService) {}

  async openBidAskPosition(request: OpenPositionRequest, owner: Keypair): Promise<OpenedPositionResult> {
    const poolAddress = new PublicKey(request.pool.address);
    const dlmm = await this.getClient(poolAddress);
    await dlmm.refetchStates();

    const activeBin = await dlmm.getActiveBin();
    const { minBinId, maxBinId } = positionRange(activeBin.binId, request.rangeBins, request.singleSidedX);
    const { amountX, amountY } = this.resolveEntryAmounts({
      amountXRaw: request.amountXRaw,
      amountYRaw: request.amountYRaw,
      activeBinId: activeBin.binId,
      binStep: dlmm.lbPair.binStep,
      activeXAmount: activeBin.xAmount,
      activeYAmount: activeBin.yAmount,
      minBinId,
      maxBinId,
      autoFillBalancedAmounts: request.autoFillBalancedAmounts ?? true
    });

    const position = Keypair.generate();
    const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: position.publicKey,
      user: owner.publicKey,
      totalXAmount: amountX,
      totalYAmount: amountY,
      strategy: {
        minBinId,
        maxBinId,
        strategyType: StrategyType.BidAsk,
        ...(request.singleSidedX !== undefined ? { singleSidedX: request.singleSidedX } : {})
      },
      slippage: request.slippagePct
    });

    const signature = await this.rpc.sendTransaction(tx, [owner, position], `open ${request.pool.name}`);
    await dlmm.refetchStates();

    return {
      positionAddress: position.publicKey.toBase58(),
      lowerBinId: minBinId,
      upperBinId: maxBinId,
      activeBinId: activeBin.binId,
      txSignature: signature,
      amountXRaw: amountX.toString(),
      amountYRaw: amountY.toString()
    };
  }

  async getPosition(poolAddress: string, owner: PublicKey, positionAddress: string): Promise<{
    activeBinId: number;
    position: LbPosition;
  }> {
    const dlmm = await this.getClient(new PublicKey(poolAddress));
    await dlmm.refetchStates();
    const { activeBin, userPositions } = await dlmm.getPositionsByUserAndLbPair(owner);
    const target = new PublicKey(positionAddress);
    const position = userPositions.find((item) => item.publicKey.equals(target));
    if (!position) {
      throw new Error(`Position ${positionAddress} not found in pool ${poolAddress}`);
    }
    return {
      activeBinId: activeBin.binId,
      position
    };
  }

  async removeAllAndClaim(poolAddress: string, owner: Keypair, positionAddress: string): Promise<string[]> {
    const dlmm = await this.getClient(new PublicKey(poolAddress));
    const { position } = await this.getPosition(poolAddress, owner.publicKey, positionAddress);
    const range = getPositionLowerUpperBinIdWithLiquidity(position.positionData);
    const fromBinId = range?.lowerBinId.toNumber() ?? position.positionData.lowerBinId;
    const toBinId = range?.upperBinId.toNumber() ?? position.positionData.upperBinId;
    logger.warn(
      {
        position: positionAddress,
        pool: poolAddress,
        fromBinId,
        toBinId
      },
      "Building DLMM remove liquidity transaction"
    );

    const txs = await dlmm.removeLiquidity({
      user: owner.publicKey,
      position: position.publicKey,
      fromBinId,
      toBinId,
      bps: new BN(BASIS_POINT_MAX),
      shouldClaimAndClose: true
    });
    logger.warn({ position: positionAddress, pool: poolAddress, txCount: txs.length }, "Sending DLMM exit transactions");

    const signatures: string[] = [];
    for (const [index, tx] of txs.entries()) {
      const signature = await this.rpc.sendTransaction(
        tx,
        [owner],
        `exit ${positionAddress} ${index + 1}/${txs.length}`,
        owner.publicKey
      );
      signatures.push(signature);
      logger.info(
        {
          position: positionAddress,
          pool: poolAddress,
          index: index + 1,
          total: txs.length,
          signature
        },
        "DLMM exit transaction confirmed"
      );
    }
    await dlmm.refetchStates();
    return signatures;
  }

  private getClient(poolAddress: PublicKey): Promise<DLMM> {
    const key = poolAddress.toBase58();
    const cached = this.clients.get(key);
    if (cached) {
      return cached;
    }
    const created = DLMM.create(this.rpc.connection, poolAddress, {
      cluster: "mainnet-beta"
    });
    this.clients.set(key, created);
    return created;
  }

  private resolveEntryAmounts(input: {
    amountXRaw: string;
    amountYRaw: string;
    activeBinId: number;
    binStep: number;
    activeXAmount: BN;
    activeYAmount: BN;
    minBinId: number;
    maxBinId: number;
    autoFillBalancedAmounts: boolean;
  }): { amountX: BN; amountY: BN } {
    let amountX = new BN(input.amountXRaw);
    let amountY = new BN(input.amountYRaw);
    if (amountX.isZero() && amountY.isZero()) {
      throw new Error("At least one entry amount must be greater than zero.");
    }

    if (!input.autoFillBalancedAmounts) {
      return { amountX, amountY };
    }

    if (amountY.isZero() && !amountX.isZero()) {
      amountY = autoFillYByStrategy(
        input.activeBinId,
        input.binStep,
        amountX,
        input.activeXAmount,
        input.activeYAmount,
        input.minBinId,
        input.maxBinId,
        StrategyType.BidAsk
      );
    }

    if (amountX.isZero() && !amountY.isZero()) {
      amountX = autoFillXByStrategy(
        input.activeBinId,
        input.binStep,
        amountY,
        input.activeXAmount,
        input.activeYAmount,
        input.minBinId,
        input.maxBinId,
        StrategyType.BidAsk
      );
    }

    return { amountX, amountY };
  }
}

function positionRange(
  activeBinId: number,
  rangeBins: number,
  singleSidedX?: boolean
): { minBinId: number; maxBinId: number } {
  if (!Number.isInteger(rangeBins) || rangeBins < 1) {
    throw new Error(`Invalid rangeBins: ${rangeBins}`);
  }

  if (singleSidedX === true) {
    return {
      minBinId: activeBinId,
      maxBinId: activeBinId + rangeBins - 1
    };
  }

  if (singleSidedX === false) {
    return {
      minBinId: activeBinId - rangeBins + 1,
      maxBinId: activeBinId
    };
  }

  const lowerBins = Math.floor((rangeBins - 1) / 2);
  const upperBins = rangeBins - 1 - lowerBins;
  return {
    minBinId: activeBinId - lowerBins,
    maxBinId: activeBinId + upperBins
  };
}
