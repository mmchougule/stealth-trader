/**
 * Telegram command contract:
 *   - unauthorized → polite rejection, no DB writes
 *   - /follow with bad args → usage hint, no DB writes
 *   - /follow with valid args → INSERT, reply names the truncated wallet
 *   - /follows lists active follows for the caller only
 *   - /unfollow flips active=false
 *
 * Postgres is mocked with a recording shim that supports the exact
 * statements the handlers issue. The grammy framework is not loaded —
 * we call the handlers directly with a fake CommandCtx.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTelegramHandlers } from "./telegram.js";

class MemPool {
  rows = new Map<string, Array<Record<string, unknown>>>();
  calls: Array<{ sql: string; params?: unknown[] }> = [];

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (/INSERT INTO stealth.users/.test(sql)) {
      return { rowCount: 1, rows: [] };
    }
    if (/INSERT INTO stealth.follows/.test(sql)) {
      const tg = params![0] as number;
      const wallet = params![1] as string;
      const perTrade = params![2] as string;
      const arr = this.rows.get("follows") ?? [];
      const existing = arr.find((r) => r.follower_tg === tg && r.leader_wallet === wallet);
      if (existing) {
        existing.per_trade_lamports = perTrade; existing.active = true;
        return { rowCount: 1, rows: [{ id: existing.id }] };
      }
      const id = arr.length + 1;
      arr.push({ id, follower_tg: tg, leader_wallet: wallet, per_trade_lamports: perTrade, daily_budget_lamports: params![3], active: true });
      this.rows.set("follows", arr);
      return { rowCount: 1, rows: [{ id }] };
    }
    if (/SELECT leader_wallet/.test(sql)) {
      const tg = params![0] as number;
      const out = (this.rows.get("follows") ?? []).filter((r) => r.follower_tg === tg);
      return { rowCount: out.length, rows: out };
    }
    if (/UPDATE stealth.follows SET active = FALSE/.test(sql)) {
      const tg = params![0] as number;
      const wallet = params![1] as string;
      const arr = this.rows.get("follows") ?? [];
      const row = arr.find((r) => r.follower_tg === tg && r.leader_wallet === wallet && r.active);
      if (!row) return { rowCount: 0, rows: [] };
      row.active = false;
      return { rowCount: 1, rows: [{ id: row.id }] };
    }
    throw new Error(`unhandled SQL: ${sql}`);
  }
}

function ctx(tgId: number, text: string) {
  const replies: string[] = [];
  return {
    tgId, text,
    reply: async (m: string) => { replies.push(m); },
    replies,
  };
}

describe("telegram /follow", () => {
  let pool: MemPool;
  let handlers: ReturnType<typeof makeTelegramHandlers>;

  beforeEach(() => {
    pool = new MemPool();
    handlers = makeTelegramHandlers({ pool: pool as unknown as never, authorizedTgUsers: new Set([1]) });
  });

  it("rejects unauthorized users without DB writes", async () => {
    const c = ctx(999, "/follow ABCwallet 0.005");
    await handlers.follow(c);
    expect(c.replies[0]).toBe("not authorized");
    expect(pool.calls.filter((x) => /INSERT/.test(x.sql))).toHaveLength(0);
  });

  it("rejects bad arg counts with usage", async () => {
    const c = ctx(1, "/follow");
    await handlers.follow(c);
    expect(c.replies[0]).toMatch(/usage:/);
    expect(pool.calls.filter((x) => /INSERT/.test(x.sql))).toHaveLength(0);
  });

  it("rejects non-numeric SOL amounts", async () => {
    const c = ctx(1, "/follow ABCwallet not-a-number");
    await handlers.follow(c);
    expect(c.replies[0]).toMatch(/invalid SOL amount/);
  });

  it("rejects amounts under 0.001 SOL", async () => {
    const c = ctx(1, "/follow ABCwallet 0.0005");
    await handlers.follow(c);
    expect(c.replies[0]).toMatch(/minimum per-trade size/);
  });

  it("inserts a follow row and confirms with the truncated wallet", async () => {
    const c = ctx(1, "/follow ABCDEFGHIJKLMNOPQRSTUVWXYZ 0.005");
    await handlers.follow(c);
    expect(c.replies[0]).toMatch(/following ABCDEF…WXYZ/);
    const rows = pool.rows.get("follows") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].per_trade_lamports).toBe("5000000"); // 0.005 * 1e9
  });

  it("upserts when called twice for the same wallet", async () => {
    await handlers.follow(ctx(1, "/follow ABCDEFGHIJKLMN 0.005"));
    await handlers.follow(ctx(1, "/follow ABCDEFGHIJKLMN 0.010"));
    const rows = pool.rows.get("follows") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].per_trade_lamports).toBe("10000000");
  });
});

describe("telegram /follows", () => {
  it("lists only the caller's follows", async () => {
    const pool = new MemPool();
    pool.rows.set("follows", [
      { id: 1, follower_tg: 1, leader_wallet: "AAA1234567890XYZ", per_trade_lamports: "5000000", active: true },
      { id: 2, follower_tg: 2, leader_wallet: "BBB1234567890XYZ", per_trade_lamports: "5000000", active: true },
    ]);
    const handlers = makeTelegramHandlers({ pool: pool as unknown as never, authorizedTgUsers: new Set([1, 2]) });
    const c1 = ctx(1, "/follows");
    await handlers.follows(c1);
    expect(c1.replies[0]).toMatch(/AAA123/);
    expect(c1.replies[0]).not.toMatch(/BBB123/);
  });

  it("informs an empty list state", async () => {
    const pool = new MemPool();
    const handlers = makeTelegramHandlers({ pool: pool as unknown as never, authorizedTgUsers: new Set([1]) });
    const c = ctx(1, "/follows");
    await handlers.follows(c);
    expect(c.replies[0]).toMatch(/no active follows/);
  });
});

describe("telegram /unfollow", () => {
  it("flips active=false and reports success", async () => {
    const pool = new MemPool();
    pool.rows.set("follows", [
      { id: 1, follower_tg: 1, leader_wallet: "AAAwallet", per_trade_lamports: "5000000", active: true },
    ]);
    const handlers = makeTelegramHandlers({ pool: pool as unknown as never, authorizedTgUsers: new Set([1]) });
    const c = ctx(1, "/unfollow AAAwallet");
    await handlers.unfollow(c);
    expect(c.replies[0]).toMatch(/stopped copying/);
    const row = pool.rows.get("follows")![0];
    expect(row.active).toBe(false);
  });

  it("returns a clear message for a wallet that isn't followed", async () => {
    const pool = new MemPool();
    const handlers = makeTelegramHandlers({ pool: pool as unknown as never, authorizedTgUsers: new Set([1]) });
    const c = ctx(1, "/unfollow NotMineWallet");
    await handlers.unfollow(c);
    expect(c.replies[0]).toMatch(/no active follow/);
  });
});
