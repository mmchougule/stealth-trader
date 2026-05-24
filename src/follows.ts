/**
 * Postgres-backed implementation of FollowStore (the interface
 * copy-trade/execute.ts expects).
 *
 * Each call is a single SQL statement — no transactions are needed
 * because the orchestrator works one (follow, leader_sig) at a time
 * and the UNIQUE constraint on copy_trades_log dedupes concurrent
 * inserts at the database level.
 */
import type { DbPool } from "./db/index.js";
import type { Follow, CopyOutcome, FollowStore } from "./copy-trade/types.js";

export function makeFollowStore(pool: DbPool): FollowStore {
  return {
    async activeForLeader(leader: string): Promise<Follow[]> {
      const r = await pool.query(
        `SELECT id, follower_tg, leader_wallet, per_trade_lamports, active
         FROM stealth.follows
         WHERE leader_wallet = $1 AND active = TRUE`,
        [leader],
      );
      return r.rows.map((row): Follow => ({
        id: Number(row.id),
        followerTg: Number(row.follower_tg),
        leaderWallet: row.leader_wallet,
        perTradeLamports: BigInt(row.per_trade_lamports),
        active: row.active,
      }));
    },

    async alreadyLogged(followId: number, leaderSig: string): Promise<boolean> {
      const r = await pool.query(
        `SELECT 1 FROM stealth.copy_trades_log
         WHERE follow_id = $1 AND leader_sig = $2 LIMIT 1`,
        [followId, leaderSig],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async insertLog(row: CopyOutcome): Promise<void> {
      await pool.query(
        `INSERT INTO stealth.copy_trades_log
           (follow_id, leader_sig, follower_sig, mint, amount_lamports, status, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (follow_id, leader_sig) DO NOTHING`,
        [row.followId, row.leaderSig, row.followerSig ?? null, row.mint, row.amountLamports.toString(), row.status, row.reason ?? null],
      );
    },

    async dailySpent(followId: number): Promise<bigint> {
      const r = await pool.query(
        `SELECT COALESCE(SUM(amount_lamports), 0) AS spent
         FROM stealth.copy_trades_log
         WHERE follow_id = $1
           AND status IN ('success', 'failed')
           AND created_at > NOW() - INTERVAL '24 hours'`,
        [followId],
      );
      return BigInt(r.rows[0].spent);
    },

    async dailyBudget(followId: number): Promise<bigint> {
      const r = await pool.query(
        `SELECT daily_budget_lamports FROM stealth.follows WHERE id = $1`,
        [followId],
      );
      if (r.rowCount === 0) return 0n;
      return BigInt(r.rows[0].daily_budget_lamports);
    },
  };
}
