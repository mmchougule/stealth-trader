/**
 * Per-user Solana keypair derivation.
 *
 * Each Telegram user gets a deterministic ed25519 keypair derived from
 *   key = HKDF-SHA512(MASTER_SEED, salt = "stealth-trader/v1", info = `tg:${tgId}`)
 *
 * Deterministic so the same tg_id always produces the same public key
 * even after restarts and across operator-side process replacements.
 *
 * SECURITY:
 *   - MASTER_SEED is the root of trust for every user's funds. Losing
 *     it locks every derived wallet permanently. Operators must store
 *     it offline.
 *   - 32 random bytes is sufficient — 256 bits of entropy.
 *   - The bot NEVER persists derived secret keys to the database. The
 *     public side is cached in stealth.users.solana_pubkey for indexing;
 *     secrets are re-derived on each request from MASTER_SEED + tgId.
 *
 * The masterSeed is passed in as bytes so loadConfig can validate the
 * env input (hex length, etc.) before any module reaches for it.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { Keypair } from "@solana/web3.js";

const SALT = new TextEncoder().encode("stealth-trader/v1");

export function deriveUserKeypair(tgId: number, masterSeed: Uint8Array): Keypair {
  if (masterSeed.length !== 32) {
    throw new Error(`masterSeed must be 32 bytes, got ${masterSeed.length}`);
  }
  if (!Number.isInteger(tgId) || tgId <= 0) {
    throw new Error(`tgId must be a positive integer, got ${tgId}`);
  }
  const info = new TextEncoder().encode(`tg:${tgId}`);
  // HKDF-SHA512 with 32-byte output — ed25519 seed length.
  const seed32 = hkdf(sha512, masterSeed, SALT, info, 32);
  return Keypair.fromSeed(seed32);
}

/**
 * Decode a hex MASTER_SEED from the env. Throws with a useful message
 * if the input isn't exactly 64 hex chars.
 */
export function parseMasterSeed(hex: string): Uint8Array {
  const s = hex.trim().toLowerCase();
  if (s.length !== 64) throw new Error("MASTER_SEED must be 64 hex chars (32 bytes)");
  if (!/^[0-9a-f]+$/.test(s)) throw new Error("MASTER_SEED is not valid hex");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
