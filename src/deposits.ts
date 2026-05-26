/**
 * Deposit watcher — delta-balance polling.
 *
 * Algorithm (ported from b402-trader, mainnet-tested live):
 *   Every N ms, for every user with a derived deposit address:
 *     1. Read on-chain SOL balance via Connection.getMultipleAccountsInfo
 *        (batched ≤100 keys/RPC call — Solana's hard limit).
 *     2. Compare to `last_seen_deposit_balance_lamports` baseline column.
 *     3. If on-chain ≥ baseline + MIN_DEPOSIT, credit the delta and
 *        advance the baseline atomically inside a tx.
 *
 * Why this beats the Helius-tx-history approach the old deposits.ts used:
 *   - Naturally idempotent. Once baseline catches up, no further credits.
 *   - Single RPC roundtrip per 100 users (vs N per-user tx-history calls).
 *   - Survives RPC reorderings — only the current balance matters, not
 *     the order of historical txs.
 *
 * The on-chain balance is the only source of truth. No ledger entry per
 * deposit signature; the column update + sol_balance_lamports update
 * happen in a single tx so a crash mid-flight either credits + advances
 * baseline, or neither.
 */
import { Connection } from "@solana/web3.js";
import type { DbPool } from "./db/index.js";
import { withTx } from "./db/index.js";
import { deriveUserKeypair } from "./wallet.js";
import { log } from "./log.js";

/** Minimum on-chain delta to consider a "deposit". Below this we silently
 *  advance baseline so dust transfers don't trigger user-visible credits. */
export const MIN_DEPOSIT_LAMPORTS = 5_000_000n; // 0.005 SOL

export type NotifyFn = (tgId: number, text: string) => Promise<void>;

export interface DepositWatcherDeps {
  pool: DbPool;
  connection: Connection;
  masterSeed: Uint8Array;
  /** Optional Telegram notifier — fires on every credited deposit. */
  notify?: NotifyFn;
  /** Poll interval in ms. Default: 10000 (10s). */
  intervalMs?: number;
}

export function startDepositWatcher(deps: DepositWatcherDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? 10_000;
  let running = true;

  const loop = async (): Promise<void> => {
    while (running) {
      try { await pollOnce(deps); }
      catch (e) { log.error({ err: (e as Error).message }, "deposit poll failed"); }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void loop();
  log.info({ intervalMs }, "deposit watcher started");
  return { stop: () => { running = false; } };
}

async function pollOnce(deps: DepositWatcherDeps): Promise<void> {
  const r = await deps.pool.query<{ tg_id: string; last_seen_deposit_balance_lamports: string }>(
    `SELECT tg_id::text, last_seen_deposit_balance_lamports::text
     FROM stealth.users`,
  );
  if (r.rowCount === 0) return;
  const users = r.rows.map((row) => ({
    tgId: Number(row.tg_id),
    baseline: BigInt(row.last_seen_deposit_balance_lamports),
  }));
  const pubkeys = users.map((u) => deriveUserKeypair(u.tgId, deps.masterSeed).publicKey);

  // Batch ≤100 per RPC call. Solana RPC enforces this; larger requests 400.
  for (let i = 0; i < pubkeys.length; i += 100) {
    const slice = pubkeys.slice(i, i + 100);
    const sliceUsers = users.slice(i, i + 100);
    const accounts = await deps.connection.getMultipleAccountsInfo(slice, "confirmed");
    for (let j = 0; j < accounts.length; j++) {
      const info = accounts[j];
      const onchain = info ? BigInt(info.lamports) : 0n;
      const { tgId, baseline } = sliceUsers[j]!;
      if (onchain >= baseline + MIN_DEPOSIT_LAMPORTS) {
        await handleDeposit(deps, tgId, onchain, baseline);
      }
    }
  }
}

async function handleDeposit(
  deps: DepositWatcherDeps,
  tgId: number,
  onchain: bigint,
  baseline: bigint,
): Promise<void> {
  const credit = onchain - baseline;
  if (credit <= 0n) {
    // Defensive: also covers the case where on-chain dropped below baseline
    // (user spent some). Just resync baseline so we don't credit phantom
    // amounts on the next poll.
    await deps.pool.query(
      `UPDATE stealth.users SET last_seen_deposit_balance_lamports = $1::bigint
       WHERE tg_id = $2`,
      [onchain.toString(), tgId],
    );
    return;
  }

  await withTx(deps.pool, async (c) => {
    await c.query(
      `UPDATE stealth.users
         SET sol_balance_lamports = sol_balance_lamports + $1::bigint,
             last_seen_deposit_balance_lamports = $2::bigint,
             updated_at = NOW()
       WHERE tg_id = $3`,
      [credit.toString(), onchain.toString(), tgId],
    );
  });
  log.info({ tgId, creditLamports: credit.toString() }, "credited deposit");

  if (deps.notify) {
    const sol = Number(credit) / 1e9;
    try {
      await deps.notify(tgId, `+${sol.toFixed(4)} SOL credited.\nReady to trade — tap /buy or /follow.`);
    } catch (e) {
      log.warn({ err: (e as Error).message }, "deposit notify failed");
    }
  }
}
