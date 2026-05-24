/**
 * Deposit watcher.
 *
 * Periodically asks Helius for inbound SOL transfers to each user's
 * derived wallet. New transfers credit the user's `sol_balance_lamports`
 * and append a `deposit` row to the ledger.
 *
 * State:
 *   - `last_seen_slot` per user lives in stealth.system_config as
 *     `deposit_cursor:<tg_id>`. The watcher only reports transfers
 *     in slots strictly greater than the cursor, so a process restart
 *     does NOT double-credit.
 *   - Helius's enhanced-tx endpoint is the source. We treat any
 *     SYSTEM_PROGRAM TRANSFER whose `toUserAccount === watchedPubkey`
 *     as a deposit.
 *
 * The poll interval defaults to 10s. The watcher caps batches at 50 txs
 * per user per tick so a long backlog doesn't stall the whole loop.
 *
 * Pure functions in this module (extractDeposits, cursorKey) are tested
 * directly; the boot loop is wired in bot.ts.
 */
import type { DbPool } from "./db/index.js";

const WSOL_AMOUNT_PATH = "amount"; // Helius native transfer field

export interface RawHeliusTx {
  signature: string;
  slot: number;
  timestamp?: number;
  type?: string;
  source?: string;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
}

export interface Deposit {
  tgId: number;
  toPubkey: string;
  fromPubkey: string;
  lamports: bigint;
  signature: string;
  slot: number;
}

/**
 * Pure: given a batch of Helius txs and a watched pubkey, return the
 * subset that are inbound SOL transfers AFTER `sinceSlot`. The bot maps
 * pubkey ↔ tgId before storing.
 */
export function extractDeposits(
  txs: RawHeliusTx[],
  watchedPubkey: string,
  sinceSlot: number,
): Omit<Deposit, "tgId">[] {
  const out: Omit<Deposit, "tgId">[] = [];
  for (const tx of txs) {
    if (tx.slot <= sinceSlot) continue;
    const transfers = tx.nativeTransfers ?? [];
    let totalIn = 0n;
    let fromPubkey = "";
    for (const t of transfers) {
      if (t.toUserAccount !== watchedPubkey) continue;
      // Skip self-transfers (user moving SOL between their own accounts).
      if (t.fromUserAccount === watchedPubkey) continue;
      totalIn += BigInt(t[WSOL_AMOUNT_PATH]);
      if (!fromPubkey) fromPubkey = t.fromUserAccount;
    }
    if (totalIn <= 0n) continue;
    out.push({
      toPubkey: watchedPubkey,
      fromPubkey,
      lamports: totalIn,
      signature: tx.signature,
      slot: tx.slot,
    });
  }
  return out;
}

export function cursorKey(tgId: number): string {
  return `deposit_cursor:${tgId}`;
}

export async function readCursor(pool: DbPool, tgId: number): Promise<number> {
  const r = await pool.query(
    `SELECT value FROM stealth.system_config WHERE key = $1`,
    [cursorKey(tgId)],
  );
  if ((r.rowCount ?? 0) === 0) return 0;
  const n = Number(r.rows[0].value);
  return Number.isFinite(n) ? n : 0;
}

export async function writeCursor(pool: DbPool, tgId: number, slot: number): Promise<void> {
  await pool.query(
    `INSERT INTO stealth.system_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [cursorKey(tgId), String(slot)],
  );
}
