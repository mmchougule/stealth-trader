/**
 * MCP handler contract:
 *   - schema validation rejects bad input
 *   - DB writes match the Telegram side (same SQL, same effect)
 *   - private_buy reaches the injected trade backend with the right amount
 *   - cashout is gated by the optional dep being present
 *   - discover_leaders sorts by score desc
 */
import { describe, it, expect, beforeEach } from "vitest";
import { handlers, type McpDeps } from "./handlers.js";

class MemPool {
  follows = new Map<string, Record<string, unknown>>();
  users = new Map<number, { sol_balance_lamports: bigint; solana_pubkey?: string }>();
  async query(sql: string, params?: unknown[]) {
    if (/INSERT INTO stealth.users \(tg_id, solana_pubkey\)/.test(sql)) {
      this.users.set(params![0] as number, { sol_balance_lamports: 0n, solana_pubkey: params![1] as string });
      return { rowCount: 1, rows: [] };
    }
    if (/INSERT INTO stealth.users \(tg_id\)/.test(sql)) {
      const tg = params![0] as number;
      if (!this.users.has(tg)) this.users.set(tg, { sol_balance_lamports: 0n });
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT sol_balance_lamports/.test(sql)) {
      const u = this.users.get(params![0] as number);
      if (!u) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ sol_balance_lamports: u.sol_balance_lamports.toString() }] };
    }
    if (/INSERT INTO stealth.follows/.test(sql)) {
      const k = `${params![0]}:${params![1]}`;
      const id = this.follows.size + 1;
      this.follows.set(k, { id, follower_tg: params![0], leader_wallet: params![1], per_trade_lamports: params![2], daily_budget_lamports: params![3], active: true });
      return { rowCount: 1, rows: [{ id }] };
    }
    if (/UPDATE stealth.follows SET active = FALSE/.test(sql)) {
      const k = `${params![0]}:${params![1]}`;
      const f = this.follows.get(k);
      if (!f || !f.active) return { rowCount: 0, rows: [] };
      f.active = false;
      return { rowCount: 1, rows: [{ id: f.id }] };
    }
    if (/SELECT leader_wallet/.test(sql)) {
      const tg = params![0] as number;
      const rows = [...this.follows.values()].filter((r) => r.follower_tg === tg);
      return { rowCount: rows.length, rows };
    }
    throw new Error(`unhandled SQL: ${sql}`);
  }
}

const VALID_WALLET = "8Sn7Z9wXSp7sH8GJk73Lp9wXSp7sH8GJk73Lp9wXSp77";
const VALID_MINT   = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function makeDeps(over: Partial<McpDeps> = {}): { pool: MemPool; deps: McpDeps } {
  const pool = new MemPool();
  const deps: McpDeps = {
    pool: pool as unknown as never,
    tgId: 1001,
    resolvePubkey: (id) => `PUBKEY${id}`,
    trade: {
      async executeBuy(args) {
        return { ok: true, txSignature: `sig-${args.mint.slice(0, 4)}`, tokensReceived: 1000n };
      },
    },
    ...over,
  };
  return { pool, deps };
}

describe("get_wallet", () => {
  it("returns pubkey and upserts user", async () => {
    const { pool, deps } = makeDeps();
    const r = await handlers.get_wallet({}, deps);
    expect(r.content[0].text).toContain("PUBKEY1001");
    expect(pool.users.get(1001)?.solana_pubkey).toBe("PUBKEY1001");
  });
});

describe("get_balance", () => {
  it("returns 0 for a non-existent user", async () => {
    const { deps } = makeDeps();
    const r = await handlers.get_balance({}, deps);
    expect(r.content[0].text).toMatch(/^0\.0000 SOL/);
  });
  it("formats the user's balance", async () => {
    const { pool, deps } = makeDeps();
    pool.users.set(1001, { sol_balance_lamports: 1_500_000_000n });
    const r = await handlers.get_balance({}, deps);
    expect(r.content[0].text).toMatch(/^1\.5000 SOL/);
  });
});

describe("follow", () => {
  it("validates input + inserts a row", async () => {
    const { pool, deps } = makeDeps();
    const r = await handlers.follow({ leader_wallet: VALID_WALLET, sol_per_trade: 0.005 }, deps);
    expect(r.content[0].text).toMatch(/following/);
    const k = `1001:${VALID_WALLET}`;
    expect(pool.follows.get(k)?.per_trade_lamports).toBe("5000000");
    expect(pool.follows.get(k)?.daily_budget_lamports).toBe("50000000"); // 10x default
  });

  it("respects an explicit daily_budget", async () => {
    const { pool, deps } = makeDeps();
    await handlers.follow({ leader_wallet: VALID_WALLET, sol_per_trade: 0.005, daily_budget_sol: 0.1 }, deps);
    expect(pool.follows.get(`1001:${VALID_WALLET}`)?.daily_budget_lamports).toBe("100000000");
  });

  it("rejects malformed wallet", async () => {
    const { deps } = makeDeps();
    await expect(handlers.follow({ leader_wallet: "not-base58!", sol_per_trade: 0.005 }, deps)).rejects.toThrow();
  });

  it("rejects non-positive sol_per_trade", async () => {
    const { deps } = makeDeps();
    await expect(handlers.follow({ leader_wallet: VALID_WALLET, sol_per_trade: 0 }, deps)).rejects.toThrow();
    await expect(handlers.follow({ leader_wallet: VALID_WALLET, sol_per_trade: -1 }, deps)).rejects.toThrow();
  });
});

describe("unfollow", () => {
  it("flips active=false on an existing follow", async () => {
    const { pool, deps } = makeDeps();
    await handlers.follow({ leader_wallet: VALID_WALLET, sol_per_trade: 0.005 }, deps);
    const r = await handlers.unfollow({ leader_wallet: VALID_WALLET }, deps);
    expect(r.content[0].text).toMatch(/unfollowed/);
    expect(pool.follows.get(`1001:${VALID_WALLET}`)?.active).toBe(false);
  });

  it("reports no-op for a wallet that was never followed", async () => {
    const { deps } = makeDeps();
    const r = await handlers.unfollow({ leader_wallet: VALID_WALLET }, deps);
    expect(r.content[0].text).toMatch(/no active follow/);
  });
});

describe("private_buy", () => {
  it("converts SOL float → lamports + calls trade with the right args", async () => {
    let captured: { mint: string; solLamports: bigint } | null = null;
    const { deps } = makeDeps({
      trade: { async executeBuy(args) { captured = { mint: args.mint, solLamports: args.solLamports }; return { ok: true, txSignature: "sig-X", tokensReceived: 1n }; } },
    });
    await handlers.private_buy({ mint: VALID_MINT, sol: 0.0123 }, deps);
    expect(captured).not.toBeNull();
    expect(captured!.mint).toBe(VALID_MINT);
    expect(captured!.solLamports).toBe(12_300_000n);
  });

  it("surfaces a backend error verbatim", async () => {
    const { deps } = makeDeps({
      trade: { async executeBuy() { return { ok: false, error: "no Jupiter route" }; } },
    });
    const r = await handlers.private_buy({ mint: VALID_MINT, sol: 0.001 }, deps);
    expect(r.content[0].text).toMatch(/no Jupiter route/);
  });
});

describe("cashout", () => {
  it("returns a configured-off message when no wallet dep is supplied", async () => {
    const { deps } = makeDeps();
    const r = await handlers.cashout({ recipient: VALID_WALLET, sol: 0.01 }, deps);
    expect(r.content[0].text).toMatch(/not configured/);
  });

  it("delegates to wallet.cashout when present", async () => {
    let captured: { tgId: number; recipient: string; mint?: string } | null = null;
    const { deps } = makeDeps({
      wallet: {
        async getHoldings() { return []; },
        async cashout(args) { captured = args; return { txSignature: "sig-cashout" }; },
      },
    });
    const r = await handlers.cashout({ recipient: VALID_WALLET, sol: 0.01 }, deps);
    expect(r.content[0].text).toMatch(/unshielded/);
    expect(captured!.recipient).toBe(VALID_WALLET);
  });

  it("surfaces backend errors verbatim", async () => {
    const { deps } = makeDeps({
      wallet: {
        async getHoldings() { return []; },
        async cashout() { throw new Error("Photon validity proof timeout"); },
      },
    });
    const r = await handlers.cashout({ recipient: VALID_WALLET, sol: 0.01 }, deps);
    expect(r.content[0].text).toMatch(/Photon validity proof timeout/);
  });
});

describe("private_lend", () => {
  it("returns 'not configured' when wallet dep absent", async () => {
    const { deps } = makeDeps();
    const r = await handlers.private_lend({ mint: VALID_MINT, amount: "1000000" }, deps);
    expect(r.content[0].text).toMatch(/not configured/);
  });

  it("delegates to wallet.lend with bigint amount", async () => {
    let captured: { tgId: number; mint: string; amount: bigint } | null = null;
    const { deps } = makeDeps({
      wallet: {
        async getHoldings() { return []; },
        async cashout() { return { txSignature: "" }; },
        async lend(args) { captured = args; return { txSignature: "sig-lend" }; },
      },
    });
    const r = await handlers.private_lend({ mint: VALID_MINT, amount: "1000000" }, deps);
    expect(r.content[0].text).toMatch(/lent 1000000/);
    expect(captured!.amount).toBe(1_000_000n);
  });

  it("surfaces backend errors verbatim", async () => {
    const { deps } = makeDeps({
      wallet: {
        async getHoldings() { return []; },
        async cashout() { return { txSignature: "" }; },
        async lend() { throw new Error("requires mainnet"); },
      },
    });
    const r = await handlers.private_lend({ mint: VALID_MINT, amount: "1000000" }, deps);
    expect(r.content[0].text).toMatch(/requires mainnet/);
  });
});

describe("get_holdings", () => {
  it("returns 'not configured' when wallet dep absent", async () => {
    const { deps } = makeDeps();
    const r = await handlers.get_holdings({}, deps);
    expect(r.content[0].text).toMatch(/not configured/);
  });

  it("returns 'no shielded holdings' on an empty result", async () => {
    const { deps } = makeDeps({
      wallet: { async getHoldings() { return []; }, async cashout() { return { txSignature: "" }; } },
    });
    const r = await handlers.get_holdings({}, deps);
    expect(r.content[0].text).toMatch(/no shielded holdings/);
  });

  it("formats per-mint rows with decimals", async () => {
    const { deps } = makeDeps({
      wallet: {
        async getHoldings() {
          return [
            { mint: VALID_MINT, amount: "12345678", decimals: 6 },     // 12.345678
            { mint: VALID_WALLET, amount: "5000000000", decimals: 9 }, // 5
          ];
        },
        async cashout() { return { txSignature: "" }; },
      },
    });
    const r = await handlers.get_holdings({}, deps);
    expect(r.content[0].text).toContain("12.345678");
    expect(r.content[0].text).toMatch(/\b5\b/);
  });
});

describe("discover_leaders", () => {
  it("calls the discover dep and ranks descending by score", async () => {
    const { deps } = makeDeps({
      discover: async () => [
        { wallet: VALID_WALLET, score: 1.0, buys: 5, pnlSol: 1.2 },
        { wallet: "11111111111111111111111111111111", score: 4.5, buys: 12, pnlSol: 3.0 },
      ],
    });
    const r = await handlers.discover_leaders({ candidates: [VALID_WALLET, "11111111111111111111111111111111"] }, deps);
    const lines = r.content[0].text.split("\n");
    expect(lines[0]).toContain("1111"); // higher score first
    expect(lines[1]).toContain(VALID_WALLET.slice(0, 6));
  });

  it("returns 'not configured' when discover dep is absent", async () => {
    const { deps } = makeDeps();
    const r = await handlers.discover_leaders({ candidates: [VALID_WALLET] }, deps);
    expect(r.content[0].text).toMatch(/not configured/);
  });
});
