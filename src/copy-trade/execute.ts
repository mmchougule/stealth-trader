/**
 * Copy-trade orchestrator. Takes one ParsedSwap and runs through every
 * active follow for that leader, deciding skip/success/fail per follow.
 *
 * Decisions made here (in order):
 *   1. Look up active follows for the leader_wallet.
 *   2. Per follow: dust filter (min trade size, env or per-follow override).
 *   3. Per follow: dedup against copy_trades_log by (follow_id, leader_sig).
 *   4. Per follow: clamp `per_trade_lamports` to remaining daily budget.
 *   5. Per follow: call executeBuy via the injected trade module.
 *   6. Always: persist exactly one copy_trades_log row per follow.
 *
 * All I/O is behind injected interfaces so the orchestrator is testable
 * without Postgres, the SDK, or a real time-source.
 */
import { isDust, resolveMin } from "./dust-filter.js";
import type { ParsedSwap, CopyOutcome, Follow, FollowStore } from "./types.js";

export type { FollowStore };

export interface TradeRunner {
  executeBuy(args: {
    tgId: number; mint: string; solLamports: bigint;
  }): Promise<
    | { ok: true; txSignature: string; tokensReceived: bigint }
    | { ok: false; error: string }
  >;
}

export interface CopyDeps {
  follows: FollowStore;
  trade: TradeRunner;
  /** Dust threshold from env. Each follow's `minCopyLamports` overrides. */
  envDustMin?: string | undefined;
}

export async function dispatchCopy(swap: ParsedSwap, deps: CopyDeps): Promise<CopyOutcome[]> {
  const follows = await deps.follows.activeForLeader(swap.wallet);
  const out: CopyOutcome[] = [];

  for (const f of follows) {
    const decision = await decideOne(swap, f, deps);
    await deps.follows.insertLog(decision);
    out.push(decision);
  }
  return out;
}

async function decideOne(
  swap: ParsedSwap,
  follow: Follow,
  deps: CopyDeps,
): Promise<CopyOutcome> {
  const base = {
    followId: follow.id,
    leaderSig: swap.signature,
    mint: swap.tokenOut,
    amountLamports: follow.perTradeLamports,
  } as const;

  // 1. Dust gate. Looks at the LEADER'S amount, not the follower's.
  const min = resolveMin({ envValue: deps.envDustMin });
  if (isDust({ leaderAmountIn: swap.amountIn, minLamports: min })) {
    return { ...base, status: "skipped", reason: `leader buy below dust min (${min})` };
  }

  // 2. Dedup.
  if (await deps.follows.alreadyLogged(follow.id, swap.signature)) {
    return { ...base, status: "skipped", reason: "duplicate webhook event" };
  }

  // 3. Daily budget clamp. If remaining < per_trade, skip rather than
  //    partial-fill — partial buys make accounting and refunds harder.
  const [spent, budget] = await Promise.all([
    deps.follows.dailySpent(follow.id),
    deps.follows.dailyBudget(follow.id),
  ]);
  const remaining = budget - spent;
  if (remaining < follow.perTradeLamports) {
    return { ...base, status: "skipped", reason: `daily budget exhausted (${remaining} < ${follow.perTradeLamports})` };
  }

  // 4. Execute.
  const res = await deps.trade.executeBuy({
    tgId: follow.followerTg,
    mint: swap.tokenOut,
    solLamports: follow.perTradeLamports,
  });
  if (res.ok) {
    return { ...base, status: "success", followerSig: res.txSignature };
  }
  return { ...base, status: "failed", reason: res.error };
}
