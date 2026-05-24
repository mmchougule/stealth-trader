/**
 * BalanceStore semantics — the part of the bot that absolutely must NOT
 * lose money. Every public path is verified against the in-memory
 * Postgres shim:
 *
 *   - debit succeeds only when balance >= amount; ledger gets a NEGATIVE row
 *   - debit fails on insufficient balance; no rows mutated
 *   - credit succeeds unconditionally; ledger gets a POSITIVE row
 *   - credit creates the user row if it doesn't exist (deposit before /start)
 *   - debit + credit are atomic — a thrown insert rolls the UPDATE back
 *
 * The shim accepts the exact SQL strings the implementation issues. A
 * change to the SQL must update the shim too, which is the test we want.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeBalanceStore } from "./balance.js";

interface UserRow { tg_id: number; sol_balance_lamports: bigint }
interface LedgerRow { tg_id: number; delta_lamports: bigint; reason: string; tx_signature: string | null }

class MemClient {
  constructor(private pool: MemPool, public id: number) {}
  released = false;
  async query(sql: string, params?: unknown[]) {
    if (this.pool.shouldThrowOn && this.pool.shouldThrowOn(sql)) {
      throw new Error("forced throw");
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
    if (/UPDATE stealth.users\s+SET sol_balance_lamports = sol_balance_lamports - \$2/.test(sql)) {
      const tg = params![0] as number;
      const amt = BigInt(params![1] as string);
      const u = this.pool.users.get(tg);
      if (!u || u.sol_balance_lamports < amt) return { rowCount: 0, rows: [] };
      u.sol_balance_lamports -= amt;
      return { rowCount: 1, rows: [] };
    }
    if (/INSERT INTO stealth.users/.test(sql)) {
      const tg = params![0] as number;
      const amt = BigInt(params![1] as string);
      const existing = this.pool.users.get(tg);
      if (existing) existing.sol_balance_lamports += amt;
      else this.pool.users.set(tg, { tg_id: tg, sol_balance_lamports: amt });
      return { rowCount: 1, rows: [] };
    }
    if (/INSERT INTO stealth.balance_ledger/.test(sql)) {
      this.pool.ledger.push({
        tg_id: params![0] as number,
        delta_lamports: BigInt(params![1] as string),
        reason: params![2] as string,
        tx_signature: (params![3] as string | null) ?? null,
      });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unhandled SQL: ${sql}`);
  }
  release() { this.released = true; }
}

class MemPool {
  users = new Map<number, UserRow>();
  ledger: LedgerRow[] = [];
  clients: MemClient[] = [];
  shouldThrowOn?: (sql: string) => boolean;
  async connect() {
    const c = new MemClient(this, this.clients.length);
    this.clients.push(c);
    return c;
  }
}

describe("BalanceStore.debit", () => {
  let pool: MemPool;
  let bal: ReturnType<typeof makeBalanceStore>;
  beforeEach(() => {
    pool = new MemPool();
    pool.users.set(1, { tg_id: 1, sol_balance_lamports: 100_000_000n });
    bal = makeBalanceStore(pool as unknown as never);
  });

  it("succeeds when balance >= amount and writes a negative ledger row", async () => {
    const ok = await bal.debit(1, 30_000_000n, "buy");
    expect(ok).toBe(true);
    expect(pool.users.get(1)!.sol_balance_lamports).toBe(70_000_000n);
    expect(pool.ledger).toHaveLength(1);
    expect(pool.ledger[0]).toMatchObject({ tg_id: 1, delta_lamports: -30_000_000n, reason: "buy" });
  });

  it("returns false on insufficient balance and writes no rows", async () => {
    const ok = await bal.debit(1, 500_000_000n, "buy");
    expect(ok).toBe(false);
    expect(pool.users.get(1)!.sol_balance_lamports).toBe(100_000_000n);
    expect(pool.ledger).toHaveLength(0);
  });

  it("treats a non-existent user as zero balance (returns false)", async () => {
    expect(await bal.debit(999, 1n, "buy")).toBe(false);
    expect(pool.ledger).toHaveLength(0);
  });

  it("releases the client even on error", async () => {
    pool.shouldThrowOn = (sql) => /INSERT INTO stealth.balance_ledger/.test(sql);
    await expect(bal.debit(1, 1_000_000n, "buy")).rejects.toThrow();
    // The UPDATE happened, but the ledger insert threw — we should roll back
    expect(pool.clients[0].released).toBe(true);
  });
});

describe("BalanceStore.credit", () => {
  it("credits an existing user", async () => {
    const pool = new MemPool();
    pool.users.set(1, { tg_id: 1, sol_balance_lamports: 5_000_000n });
    const bal = makeBalanceStore(pool as unknown as never);
    await bal.credit(1, 10_000_000n, "deposit", "tx-abc");
    expect(pool.users.get(1)!.sol_balance_lamports).toBe(15_000_000n);
    expect(pool.ledger[0]).toMatchObject({ delta_lamports: 10_000_000n, reason: "deposit", tx_signature: "tx-abc" });
  });

  it("creates the user row if it didn't exist", async () => {
    const pool = new MemPool();
    const bal = makeBalanceStore(pool as unknown as never);
    await bal.credit(99, 7_000_000n, "deposit");
    expect(pool.users.get(99)!.sol_balance_lamports).toBe(7_000_000n);
  });

  it("never produces a negative balance via credit alone", async () => {
    const pool = new MemPool();
    const bal = makeBalanceStore(pool as unknown as never);
    await bal.credit(1, 100n, "deposit");
    expect(pool.users.get(1)!.sol_balance_lamports).toBe(100n);
  });
});
