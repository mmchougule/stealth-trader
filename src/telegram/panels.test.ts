/**
 * Panel-level smoke. Each panel takes a CommandCtx + Deps; we build a
 * recording ctx and stub deps to verify the right text comes back for
 * each branch.
 *
 * Wider router auth + grammy wiring lives in router.ts; not exercised
 * here — the panels themselves never see grammy.
 */
import { describe, it, expect, vi } from "vitest";
import type { CommandCtx, Deps } from "./types.js";
import { showWallet } from "./panels/wallet.js";
import { showHoldings } from "./panels/holdings.js";
import { showDiscover } from "./panels/discover.js";
import { runCashout } from "./panels/cashout.js";
import { runBuy } from "./panels/buy.js";
import { runSell } from "./panels/sell.js";
import { renderLeaderStats } from "./panels/leader.js";
import type { LeaderStats } from "../leader-stats.js";

function makeCtx(text = ""): CommandCtx & { replies: string[] } {
  const replies: string[] = [];
  return {
    tgId: 42,
    text,
    replies,
    async reply(m) { replies.push(m); },
  };
}

const fakePool = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }), end: async () => {} };
const baseDeps: Deps = {
  pool: fakePool as never,
  authorizedTgUsers: new Set([42]),
  resolvePubkey: (tg) => `pubkey-${tg}`,
};

describe("wallet panel", () => {
  it("replies with the resolved pubkey", async () => {
    const ctx = makeCtx();
    await showWallet(baseDeps, ctx);
    expect(ctx.replies).toEqual(["pubkey-42"]);
  });
});

describe("holdings panel", () => {
  it("tells the user when backend isn't configured", async () => {
    const ctx = makeCtx();
    await showHoldings(baseDeps, ctx);
    expect(ctx.replies[0]).toMatch(/wallet backend not configured/);
  });

  it("renders an empty list as 'no shielded holdings.'", async () => {
    const ctx = makeCtx();
    const deps = { ...baseDeps, wallet: {
      getHoldings: async () => [],
      cashout: async () => ({ txSignature: "" }),
    }};
    await showHoldings(deps, ctx);
    expect(ctx.replies[0]).toBe("no shielded holdings.");
  });

  it("renders one row per mint with short addresses + decimals", async () => {
    const ctx = makeCtx();
    const deps = { ...baseDeps, wallet: {
      getHoldings: async () => [
        { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", amount: "1500000", decimals: 6 },
      ],
      cashout: async () => ({ txSignature: "" }),
    }};
    await showHoldings(deps, ctx);
    expect(ctx.replies[0]).toMatch(/DezXAZ…B263\s+1\.5/);
  });
});

describe("discover panel", () => {
  it("shows the empty-config message when no leaders are configured", async () => {
    // OSS default: STEALTH_DISCOVER_LEADERS unset → RECOMMENDED_LEADERS is
    // empty (parsed at module load). Panel points users at /leader instead.
    const ctx = makeCtx();
    await showDiscover(baseDeps, ctx);
    expect(ctx.replies[0]).toMatch(/no curated leaders configured/i);
    expect(ctx.replies[0]).toMatch(/\/leader/);
  });
});

describe("cashout panel", () => {
  const recipient = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

  it("rejects malformed recipient", async () => {
    const ctx = makeCtx(`/cashout not-base58`);
    const deps = { ...baseDeps, wallet: {
      getHoldings: async () => [],
      cashout: async () => ({ txSignature: "X" }),
    }};
    await runCashout(deps, ctx);
    expect(ctx.replies[0]).toMatch(/invalid recipient/);
  });

  it("calls wallet.cashout with the parsed recipient", async () => {
    const ctx = makeCtx(`/cashout ${recipient}`);
    const cashout = vi.fn(async () => ({ txSignature: "SIG" }));
    const deps = { ...baseDeps, wallet: {
      getHoldings: async () => [],
      cashout,
    }};
    await runCashout(deps, ctx);
    expect(cashout).toHaveBeenCalledWith({ tgId: 42, recipient });
    expect(ctx.replies[0]).toMatch(/sig: SIG/);
  });
});

describe("buy panel", () => {
  it("rejects bad usage", async () => {
    const ctx = makeCtx(`/buy onlyone`);
    await runBuy(baseDeps, { executeBuy: async () => ({ ok: true, txSignature: "", tokensReceived: 0n, effectiveLamports: 0n }) }, ctx);
    expect(ctx.replies[0]).toMatch(/usage:/);
  });

  it("rejects amount below MIN_TRADE_LAMPORTS", async () => {
    const ctx = makeCtx(`/buy DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 0.0000001`);
    await runBuy(baseDeps, { executeBuy: async () => ({ ok: true, txSignature: "", tokensReceived: 0n, effectiveLamports: 0n }) }, ctx);
    expect(ctx.replies[0]).toMatch(/minimum trade size/);
  });

  it("renders the receipt on success", async () => {
    const ctx = makeCtx(`/buy DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 0.01`);
    const exec = vi.fn(async () => ({
      ok: true as const, txSignature: "abc",
      tokensReceived: 123_456n, effectiveLamports: 10_000_000n,
    }));
    await runBuy(baseDeps, { executeBuy: exec }, ctx);
    expect(ctx.replies[0]).toMatch(/sig: abc/);
    expect(ctx.replies[0]).toMatch(/spent 0\.0100 SOL/);
  });
});

describe("sell panel", () => {
  it("returns the v0.6 hint when backend hasn't wired executeSell", async () => {
    const ctx = makeCtx(`/sell DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 1000`);
    await runSell(baseDeps, {}, ctx);
    expect(ctx.replies[0]).toMatch(/v0\.6/);
  });
});

describe("renderLeaderStats", () => {
  it("renders the empty-history fallback line", () => {
    const stats: LeaderStats = {
      wallet: "Wzz", lookbackSecs: 7 * 86_400,
      buys: 0, sells: 0, closed: [],
      wins: 0, losses: 0, winRatePct: null,
      netClosedSolLamports: 0n, totalBuyVolumeLamports: 0n,
      bestTrade: null, worstTrade: null, avgHoldSecs: null,
      hoursHistogram: new Array(24).fill(0), topMints: [],
    };
    const out = renderLeaderStats(stats);
    expect(out).toMatch(/No trade history in this window/);
  });
});
