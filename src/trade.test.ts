/**
 * Trade orchestration contract:
 *   - debit-before-send (insufficient balance never hits the backend)
 *   - per-user serial (proved indirectly via the in-memory balance store)
 *   - refund-on-failure (entire debit + fee returned to balance)
 *   - min trade size enforced before any debit
 *
 * The backend + balance store are in-memory test doubles. The lock is
 * proven separately in userLock.test.ts; here we just verify the
 * orchestration semantics.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTrade, MIN_TRADE_LAMPORTS, type BalanceStore, type SwapBackend } from "./trade.js";
import { _resetUserLocks } from "./userLock.js";

class MemBalance implements BalanceStore {
  bal = new Map<number, bigint>();
  log: Array<{ tg: number; delta: bigint; reason: string }> = [];
  set(tg: number, lamports: bigint) { this.bal.set(tg, lamports); }
  async debit(tg: number, lamports: bigint, reason: string) {
    const cur = this.bal.get(tg) ?? 0n;
    if (cur < lamports) return false;
    this.bal.set(tg, cur - lamports);
    this.log.push({ tg, delta: -lamports, reason });
    return true;
  }
  async credit(tg: number, lamports: bigint, reason: string) {
    const cur = this.bal.get(tg) ?? 0n;
    this.bal.set(tg, cur + lamports);
    this.log.push({ tg, delta: lamports, reason });
  }
}

class GoodBackend implements SwapBackend {
  calls: Array<{ tgId: number; mint: string; solLamports: bigint }> = [];
  async privateBuy(args: { tgId: number; mint: string; solLamports: bigint }) {
    this.calls.push(args);
    return { txSignature: `sig-${args.mint.slice(0, 4)}`, tokensReceived: args.solLamports * 100n };
  }
}

class FailingBackend implements SwapBackend {
  calls: Array<{ tgId: number; mint: string; solLamports: bigint }> = [];
  constructor(private err = "swap failed") {}
  async privateBuy(args: { tgId: number; mint: string; solLamports: bigint }) {
    this.calls.push(args);
    throw new Error(this.err);
  }
}

describe("executeBuy — happy path", () => {
  beforeEach(() => _resetUserLocks());

  it("debits balance, calls backend, returns success", async () => {
    const balance = new MemBalance();
    balance.set(1, 100_000_000n);
    const backend = new GoodBackend();
    const t = makeTrade({ backend, balance });

    const r = await t.executeBuy({ tgId: 1, mint: "XYZmint", solLamports: 5_000_000n });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.txSignature).toBe("sig-XYZm");

    // 5_000_000 + fee (5bps + 0.0003 SOL = 2500 + 300000 = 302500) = 5_302_500 debited
    expect(balance.bal.get(1)).toBe(100_000_000n - 5_302_500n);
    expect(backend.calls).toHaveLength(1);
  });
});

describe("executeBuy — rejection paths", () => {
  beforeEach(() => _resetUserLocks());

  it("returns error when amount < min trade", async () => {
    const balance = new MemBalance(); balance.set(1, 100_000_000n);
    const backend = new GoodBackend();
    const r = await makeTrade({ backend, balance }).executeBuy({
      tgId: 1, mint: "x", solLamports: MIN_TRADE_LAMPORTS - 1n,
    });
    expect(r.ok).toBe(false);
    expect(backend.calls).toHaveLength(0);
    expect(balance.bal.get(1)).toBe(100_000_000n); // no debit
  });

  it("returns error on insufficient balance, never touches backend", async () => {
    const balance = new MemBalance(); balance.set(1, 1_000_000n);
    const backend = new GoodBackend();
    const r = await makeTrade({ backend, balance }).executeBuy({
      tgId: 1, mint: "x", solLamports: 50_000_000n,
    });
    expect(r.ok).toBe(false);
    expect(backend.calls).toHaveLength(0);
  });

  it("refunds the full debit + fee when backend throws", async () => {
    const balance = new MemBalance(); balance.set(1, 100_000_000n);
    const backend = new FailingBackend("relayer down");
    const r = await makeTrade({ backend, balance }).executeBuy({
      tgId: 1, mint: "x", solLamports: 5_000_000n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/relayer down/);
    expect(balance.bal.get(1)).toBe(100_000_000n); // refund nets out
    // Ledger should show one debit then one credit of equal magnitude.
    const sum = balance.log.reduce((acc, e) => acc + e.delta, 0n);
    expect(sum).toBe(0n);
    expect(balance.log.find((e) => e.reason === "buy_refund")).toBeDefined();
  });
});

describe("executeBuy — custom fee policy", () => {
  beforeEach(() => _resetUserLocks());

  it("respects an injected computeBuyFee", async () => {
    const balance = new MemBalance(); balance.set(1, 100_000_000n);
    const backend = new GoodBackend();
    const t = makeTrade({ backend, balance, computeBuyFee: () => 0n }); // zero fee
    const r = await t.executeBuy({ tgId: 1, mint: "x", solLamports: 5_000_000n });
    expect(r.ok).toBe(true);
    expect(balance.bal.get(1)).toBe(100_000_000n - 5_000_000n);
  });
});
