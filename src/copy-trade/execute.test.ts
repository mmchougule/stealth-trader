/**
 * Copy-trade orchestrator contract:
 *   - dust → skipped with reason
 *   - duplicate leader_sig per follow → skipped with reason
 *   - daily budget exhausted → skipped with reason
 *   - trade ok → success row with followerSig
 *   - trade fail → failed row with backend error
 *   - one log row per follow per event
 *
 * The FollowStore + TradeRunner are in-memory doubles. No I/O.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { dispatchCopy, type FollowStore, type TradeRunner } from "./execute.js";
import type { ParsedSwap, CopyOutcome, Follow } from "./types.js";
import { WSOL_MINT } from "./types.js";

function swap(over: Partial<ParsedSwap> = {}): ParsedSwap {
  return {
    wallet: "LeaderWallet",
    tokenIn: WSOL_MINT,
    tokenOut: "MintXYZ",
    amountIn: 100_000_000n,
    leaderTokensOut: 1_000_000n,
    leaderTokenDecimals: 6,
    signature: "sig-leader",
    slot: 1,
    timestamp: null,
    ...over,
  };
}

function follow(over: Partial<Follow> = {}): Follow {
  return {
    id: 1,
    followerTg: 1001,
    leaderWallet: "LeaderWallet",
    perTradeLamports: 3_000_000n,
    active: true,
    ...over,
  };
}

class MemFollows implements FollowStore {
  follows: Follow[] = [];
  logged = new Map<string, CopyOutcome>();
  spent = new Map<number, bigint>();
  budget = new Map<number, bigint>();

  async activeForLeader(leader: string) {
    return this.follows.filter((f) => f.leaderWallet === leader && f.active);
  }
  async alreadyLogged(followId: number, leaderSig: string) {
    return this.logged.has(`${followId}::${leaderSig}`);
  }
  async insertLog(row: CopyOutcome) {
    this.logged.set(`${row.followId}::${row.leaderSig}`, row);
  }
  async dailySpent(followId: number) { return this.spent.get(followId) ?? 0n; }
  async dailyBudget(followId: number) { return this.budget.get(followId) ?? 1_000_000_000n; }
}

class GoodTrade implements TradeRunner {
  calls: unknown[] = [];
  async executeBuy(args: { tgId: number; mint: string; solLamports: bigint }) {
    this.calls.push(args);
    return { ok: true as const, txSignature: `sig-${args.tgId}`, tokensReceived: 1n };
  }
}

class FailingTrade implements TradeRunner {
  constructor(private err = "no Jupiter route") {}
  async executeBuy() {
    return { ok: false as const, error: this.err };
  }
}

describe("dispatchCopy", () => {
  let follows: MemFollows;
  beforeEach(() => { follows = new MemFollows(); });

  it("no active follows → no outcomes", async () => {
    const out = await dispatchCopy(swap(), { follows, trade: new GoodTrade() });
    expect(out).toEqual([]);
  });

  it("happy path produces one success row", async () => {
    follows.follows.push(follow());
    const trade = new GoodTrade();
    const out = await dispatchCopy(swap(), { follows, trade });
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("success");
    expect(out[0].followerSig).toBe("sig-1001");
    expect(trade.calls).toHaveLength(1);
  });

  it("skips when leader buy is dust", async () => {
    follows.follows.push(follow());
    const trade = new GoodTrade();
    const out = await dispatchCopy(swap({ amountIn: 1_000n }), { follows, trade });
    expect(out[0].status).toBe("skipped");
    expect(out[0].reason).toMatch(/dust/);
    expect(trade.calls).toHaveLength(0);
  });

  it("skips a duplicate webhook for the same (follow, sig)", async () => {
    follows.follows.push(follow());
    follows.logged.set("1::sig-leader", { followId: 1, leaderSig: "sig-leader", mint: "x", amountLamports: 0n, status: "success" });
    const trade = new GoodTrade();
    const out = await dispatchCopy(swap(), { follows, trade });
    expect(out[0].status).toBe("skipped");
    expect(out[0].reason).toMatch(/duplicate/);
    expect(trade.calls).toHaveLength(0);
  });

  it("skips when daily budget remaining < per_trade", async () => {
    follows.follows.push(follow());
    follows.budget.set(1, 5_000_000n);
    follows.spent.set(1, 4_000_000n); // remaining = 1M, perTrade = 3M
    const trade = new GoodTrade();
    const out = await dispatchCopy(swap(), { follows, trade });
    expect(out[0].status).toBe("skipped");
    expect(out[0].reason).toMatch(/budget/);
    expect(trade.calls).toHaveLength(0);
  });

  it("records a failed row when the backend rejects", async () => {
    follows.follows.push(follow());
    const out = await dispatchCopy(swap(), { follows, trade: new FailingTrade("Jupiter no route") });
    expect(out[0].status).toBe("failed");
    expect(out[0].reason).toMatch(/no route/);
  });

  it("emits exactly one log row per follow per event", async () => {
    follows.follows.push(follow({ id: 1, followerTg: 1001 }));
    follows.follows.push(follow({ id: 2, followerTg: 1002 }));
    const out = await dispatchCopy(swap(), { follows, trade: new GoodTrade() });
    expect(out).toHaveLength(2);
    expect(follows.logged.size).toBe(2);
  });
});
