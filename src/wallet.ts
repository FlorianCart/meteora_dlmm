import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export function loadKeypair(secret: string | undefined): Keypair {
  if (!secret || secret.trim().length === 0) {
    throw new Error("WALLET_PRIVATE_KEY is required for trading or exiting positions.");
  }

  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((v) => Number.isInteger(v))) {
      throw new Error("WALLET_PRIVATE_KEY JSON must be an array of integer bytes.");
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  }

  return Keypair.fromSecretKey(bs58.decode(trimmed));
}
