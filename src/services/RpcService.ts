import {
  Commitment,
  ConnectionConfig,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Signer,
  Transaction
} from "@solana/web3.js";
import { sleep, jitter } from "../utils/time.js";

export interface RpcServiceOptions {
  rpcUrl: string;
  wsUrl?: string;
  commitment: Commitment;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  maxRetries: number;
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

        const confirmation = await this.connection.confirmTransaction(
          {
            signature,
            blockhash: blockhash.blockhash,
            lastValidBlockHeight: blockhash.lastValidBlockHeight
          },
          this.options.commitment
        );

        if (confirmation.value.err) {
          throw new Error(`${label} failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        return signature;
      } catch (error) {
        lastError = error;
        if (!this.isRetryable(error) || attempt + 1 >= this.options.maxRetries) {
          break;
        }
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

  private isRetryable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /blockhash|expired|timeout|429|503|temporar|dropped|not confirmed|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|rate/i.test(
      message
    );
  }
}
