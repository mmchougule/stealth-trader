/**
 * Wrap native SOL into the user's wSOL ATA so sdk.shield(NATIVE_MINT, ...)
 * has a funded depositor token account.
 *
 * Idempotent: createATAIdempotent + SystemProgram.transfer + syncNative.
 * If the ATA already exists with enough wSOL, the caller should bypass
 * this entirely — that's the consumer's responsibility, not ours.
 *
 * Ported from b402-backend.ts as a focused helper. The b402-trader version
 * (src/b402-client.ts::ensureWsolBalanceWith) also pulls from shielded
 * notes when the bare wallet is short; that's a deeper recovery path
 * we don't ship in the OSS bot — strangers don't have stuck notes from
 * prior failed swaps that need rescuing.
 */
import {
  type Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export async function wrapSolForShield(
  connection: Connection,
  userKp: Keypair,
  lamports: bigint,
): Promise<string> {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, userKp.publicKey);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      userKp.publicKey,
      ata,
      userKp.publicKey,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: userKp.publicKey,
      toPubkey: ata,
      lamports: Number(lamports),
    }),
    createSyncNativeInstruction(ata),
  );
  return sendAndConfirmTransaction(connection, tx, [userKp], {
    commitment: "confirmed",
    maxRetries: 3,
  });
}
