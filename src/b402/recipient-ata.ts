/**
 * Pre-create the recipient's associated token account so sdk.unshield
 * doesn't fall back to the user's near-empty derived keypair to pay
 * rent (~0.002 SOL) and fail with "insufficient funds for rent".
 *
 * Idempotent: skip the tx when the ATA already exists.
 *
 * Only called when an operator keypair is configured. Without one,
 * fresh-recipient cashouts require the user's derived wallet to hold a
 * little spare SOL — fine for repeat users, painful for new ones.
 */
import {
  type Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

export async function ensureRecipientAta(
  connection: Connection,
  operator: Keypair,
  recipient: PublicKey,
  mint: PublicKey,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, recipient);
  const info = await connection.getAccountInfo(ata);
  if (info) return ata;
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      operator.publicKey,
      ata,
      recipient,
      mint,
    ),
  );
  await sendAndConfirmTransaction(connection, tx, [operator], {
    commitment: "confirmed",
    maxRetries: 3,
  });
  return ata;
}
