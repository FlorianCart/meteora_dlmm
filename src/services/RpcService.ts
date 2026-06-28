import {
  Commitment,
  ConnectionConfig,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Signer,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js";
import { sleep, jitter } from "../utils/time.js";
import { logger } from "../utils/logger.js";

export interface RpcServiceOptions {
  rpcUrl: string;
  wsUrl?: string;
  commitment: Commitment;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  maxRetries: number;
  confirmTimeoutMs: number;
  skipPreflight: boolean;
}

export class RpcService {
  readonly connection: Connection;

  constructor(private readonly options: RpcServiceOptions) {
    const connectionConfig: ConnectionConfig = { commitment: options.commitment };
    if (options.wsUrl) {
      connectionConfig.wsEndpoint = options.wsUrl;
    }
    this.connection = new Connection(options.rpcUrl, connectionConfig);
  }

  async sendTransaction(
    transaction: Transaction,
    signers: Signer[],
    label: string,
    payer: PublicKey = signers[0]?.publicKey ?? PublicKey.default
  ): Promise<string> {
    if (signers.length === 0) {
      throw new Error(`No signer provided for ${label}`);
    }

    this.addComputeBudget(transaction);
    let lastError: unknown;
    const pendingSignatures: string[] = [];

    for (let attempt = 0; attempt < this.options.maxRetries; attempt += 1) {
      try {
        const blockhash = await this.connection.getLatestBlockhash(this.options.commitment);
        transaction.feePayer = payer;
        transaction.recentBlockhash = blockhash.blockhash;
        transaction.sign(...signers);

        const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: this.options.skipPreflight,
          maxRetries: 0,
          preflightCommitment: this.options.commitment
        });
        pendingSignatures.push(signature);
        logger.info({ label, signature, attempt: attempt + 1 }, "Transaction sent");

        await this.confirmTransactionWithTimeout(
          {
            signature,
            blockhash: blockhash.blockhash,
            lastValidBlockHeight: blockhash.lastValidBlockHeight
          },
          label
        );
        logger.info({ label, signature, attempt: attempt + 1 }, "Transaction confirmed");
        return signature;
      } catch (error) {
        lastError = error;
        const confirmedSignature = await this.findConfirmedSignature(pendingSignatures);
        if (confirmedSignature) {
          logger.info({ label, signature: confirmedSignature }, "Previous transaction attempt confirmed");
          return confirmedSignature;
        }

        if (!this.isRetryable(error) || attempt + 1 >= this.options.maxRetries) {
          break;
        }
        logger.warn(
          { label, attempt: attempt + 1, nextAttempt: attempt + 2, error: messageFromError(error) },
          "Retrying transaction with fresh blockhash"
        );
        await sleep(jitter(Math.min(12_000, 750 * 2 ** attempt), 0.35));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async sendVersionedTransaction(
    transaction: VersionedTransaction,
    signers: Signer[],
    label: string
  ): Promise<string> {
    if (signers.length === 0) {
      throw new Error(`No signer provided for ${label}`);
    }

    let lastError: unknown;
    const pendingSignatures: string[] = [];
    for (let attempt = 0; attempt < this.options.maxRetries; attempt += 1) {
      try {
        transaction.sign(signers);
        const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: this.options.skipPreflight,
          maxRetries: 0,
          preflightCommitment: this.options.commitment
        });
        pendingSignatures.push(signature);
        logger.info({ label, signature, attempt: attempt + 1 }, "Versioned transaction sent");

        await this.confirmSignatureWithTimeout(signature, label);
        logger.info({ label, signature, attempt: attempt + 1 }, "Versioned transaction confirmed");
        return signature;
      } catch (error) {
        lastError = error;
        const confirmedSignature = await this.findConfirmedSignature(pendingSignatures);
        if (confirmedSignature) {
          logger.info({ label, signature: confirmedSignature }, "Previous versioned transaction attempt confirmed");
          return confirmedSignature;
        }

        if (!this.isRetryable(error) || attempt + 1 >= this.options.maxRetries) {
          break;
        }
        logger.warn(
          { label, attempt: attempt + 1, nextAttempt: attempt + 2, error: messageFromError(error) },
          "Retrying versioned transaction"
        );
        await sleep(jitter(Math.min(12_000, 750 * 2 ** attempt), 0.35));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private addComputeBudget(transaction: Transaction): void {
    if (transaction.instructions.some((instruction) => instruction.programId.equals(ComputeBudgetProgram.programId))) {
      return;
    }

    const prepend = [];
    if (this.options.computeUnitLimit > 0) {
      prepend.push(ComputeBudgetProgram.setComputeUnitLimit({ units: this.options.computeUnitLimit }));
    }
    if (this.options.priorityFeeMicroLamports > 0) {
      prepend.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.options.priorityFeeMicroLamports
        })
      );
    }
    if (prepend.length > 0) {
      transaction.instructions = [...prepend, ...transaction.instructions];
    }
  }

  private async confirmTransactionWithTimeout(
    strategy: {
      signature: string;
      blockhash: string;
      lastValidBlockHeight: number;
    },
    label: string
  ): Promise<void> {
    const confirmation = await Promise.race([
      this.connection.confirmTransaction(strategy, this.options.commitment),
      sleep(this.options.confirmTimeoutMs).then(() => {
        throw new Error(`${label} confirmation timeout after ${this.options.confirmTimeoutMs}ms`);
      })
    ]);

    if (confirmation.value.err) {
      throw new Error(`${label} failed: ${JSON.stringify(confirmation.value.err)}`);
    }
  }

  private async confirmSignatureWithTimeout(signature: string, label: string): Promise<void> {
    const confirmation = await Promise.race([
      this.connection.confirmTransaction(signature, this.options.commitment),
      sleep(this.options.confirmTimeoutMs).then(() => {
        throw new Error(`${label} confirmation timeout after ${this.options.confirmTimeoutMs}ms`);
      })
    ]);

    if (confirmation.value.err) {
      throw new Error(`${label} failed: ${JSON.stringify(confirmation.value.err)}`);
    }
  }

  private async findConfirmedSignature(signatures: string[]): Promise<string | null> {
    const uniqueSignatures = [...new Set(signatures)];
    if (uniqueSignatures.length === 0) {
      return null;
    }

    const statuses = await this.connection.getSignatureStatuses(uniqueSignatures, {
      searchTransactionHistory: false
    });
    for (const [index, status] of statuses.value.entries()) {
      if (!status || status.err || !this.hasReachedConfiguredCommitment(status.confirmationStatus)) {
        continue;
      }

      const signature = uniqueSignatures[index];
      if (signature) {
        return signature;
      }
    }
    return null;
  }

  private hasReachedConfiguredCommitment(status: "processed" | "confirmed" | "finalized" | null | undefined): boolean {
    if (!status) {
      return false;
    }

    if (this.options.commitment === "finalized") {
      return status === "finalized";
    }

    if (this.options.commitment === "confirmed") {
      return status === "confirmed" || status === "finalized";
    }

    return status === "processed" || status === "confirmed" || status === "finalized";
  }

  private isRetryable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /blockhash|expired|timeout|429|503|temporar|dropped|not confirmed|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|rate/i.test(
      message
    );
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
