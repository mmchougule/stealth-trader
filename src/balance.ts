/**
 * Postgres-backed BalanceStore — atomic debit + audited credit.
 *
 * Contract (matches src/trade.ts):
 *   debit(tg, lamports, reason): UPDATE stealth.users
 *      SET sol_balance_lamports = sol_balance_lamports - $lamports
 *      WHERE tg_id = $tg AND sol_balance_lamports >= $lamports
 *      RETURNING 1
 *   - If rowCount === 0, the caller didn't have enough balance; return false.
 *   - On success, append a balance_ledger row with the negative delta.
 *
 * credit(tg, lamports, reason, txSignature?): always succeeds (no negative
 *   guard), appends a balance_ledger row with the positive delta.
 *
 * Both operations run in a single SQL transaction so the update + ledger
 * append are atomic. A user reading mid-way through either sees the
 * pre-call state or the post-call state.
 */
import type { DbPool } from "./db/index.js";
import type { BalanceStore } from "./trade.js";

export function makeBalanceStore(pool: DbPool): BalanceStore {
  return {
    async debit(tgId: number, lamports: bigint, reason: string): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const upd = await client.query(
          `UPDATE stealth.users
           SET sol_balance_lamports = sol_balance_lamports - $2,
               updated_at = NOW()
           WHERE tg_id = $1 AND sol_balance_lamports >= $2`,
          [tgId, lamports.toString()],
        );
        if (upd.rowCount === 0) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          `INSERT INTO stealth.balance_ledger (tg_id, delta_lamports, reason)
           VALUES ($1, $2, $3)`,
          [tgId, (-lamports).toString(), reason],
        );
        await client.query("COMMIT");
        return true;
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      } finally {
        client.release();
      }
    },

    async credit(tgId: number, lamports: bigint, reason: string, txSignature?: string): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Upsert: if the user row doesn't exist yet (deposit landing before
        // /start), create it. Either way bump the balance.
        await client.query(
          `INSERT INTO stealth.users (tg_id, sol_balance_lamports)
           VALUES ($1, $2)
           ON CONFLICT (tg_id) DO UPDATE
             SET sol_balance_lamports = stealth.users.sol_balance_lamports + EXCLUDED.sol_balance_lamports,
                 updated_at = NOW()`,
          [tgId, lamports.toString()],
        );
        await client.query(
          `INSERT INTO stealth.balance_ledger (tg_id, delta_lamports, reason, tx_signature)
           VALUES ($1, $2, $3, $4)`,
          [tgId, lamports.toString(), reason, txSignature ?? null],
        );
        await client.query("COMMIT");
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
