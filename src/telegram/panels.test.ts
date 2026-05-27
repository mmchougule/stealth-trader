/**
 * Panel-level smoke. Each panel takes a CommandCtx + Deps; we build a
 * recording ctx and stub deps to verify the right text comes back for
 * each branch.
 *
 * Wider router auth + grammy wiring lives in router.ts; not exercised
 * here — the panels themselves never see grammy.
 */
import { describe, it, expect, vi } from "vitest";
// Keep the suite deterministic + offline: the buy CLI path calls the RugCheck
// safety gate, which would otherwise hit the network and flake on rate limits.
vi.mock("../safety.js", () => ({ checkToken: async () => ({ pass: true, score: 0 }) }));
import type { CommandCtx, Deps } from "./types.js";
import { showWallet } from "./panels/wallet.js";
import { showHoldings, renderHoldings } from "./panels/holdings.js";
import { showDiscover } from "./panels/discover.js";
import {
  runCashout, renderWithdrawNotes, onWithdrawNote, presentWithdrawNotes,
} from "./panels/cashout.js";
import type { CallbackCtx, Keyboard } from "./types.js";
import { runBuy, type BuyDeps } from "./panels/buy.js";
import { runSell, openSellTokenList, type SellDeps } from "./panels/sell.js";
import { renderLeaderStats } from "./panels/leader.js";
import { makeFlowState } from "./state.js";
import type { LeaderStats } from "../leader-stats.js";

// A BuyDeps whose lookups all no-op; individual tests override what they
// care about. executeBuy defaults to a success so the receipt path is hit.
function makeBuyDeps(over: Partial<BuyDeps> = {}): BuyDeps {
  return {
    executeBuy: async () => ({ ok: true as const, txSignature: "", tokensReceived: 0n, effectiveLamports: 0n }),
    publicSolLamports: async () => 0n,
    shieldedSolNotes: async () => [],
    tokenMeta: async () => ({ symbol: null, decimals: 6 }),
    quoteTokensOut: async () => null,
    computeBuyFee: () => 300_000n,
    ...over,
  };
}

function makeSellDeps(over: Partial<SellDeps> = {}): SellDeps {
  return {
    holdings: async () => [],
    tokenNotes: async () => [],
    quoteSolOut: async () => null,
    ...over,
  };
}

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
  it("shows the deposit address + empty-private section with no backend", async () => {
    const ctx = makeCtx();
    await showWallet(baseDeps, ctx);
    expect(ctx.replies[0]).toMatch(/💼 Wallet/);
    expect(ctx.replies[0]).toMatch(/Private — empty/);
    expect(ctx.replies[0]).toContain("pubkey-42"); // deposit address still shown
  });

  it("sums shielded wSOL notes into the Private SOL line", async () => {
    const ctx = makeCtx();
    const deps = { ...baseDeps, wallet: {
      getHoldings: async () => [],
      cashout: async () => ({ txSignature: "" }),
      getNotes: async () => [
        { id: "n1", mint: "So11111111111111111111111111111111111111112", amount: 30_000_000n },
        { id: "n2", mint: "So11111111111111111111111111111111111111112", amount: 20_000_000n },
      ],
    }};
    await showWallet(deps, ctx);
    // 0.05 SOL total across 2 notes.
    expect(ctx.replies[0]).toMatch(/Private/);
    expect(ctx.replies[0]).toMatch(/0\.0500.*2 notes/s);
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

  it("renders a per-token Sell button keyed by mint", () => {
    const v = renderHoldings([
      { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", amount: "1500000", decimals: 6, symbol: "BAGS" },
    ]);
    const btn = v.keyboard.flat()[0]!;
    expect(btn.text).toBe("Sell BAGS");
    expect(btn.callbackData).toBe("sell:mint:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
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

// CallbackCtx recorder for tap-handler tests.
function makeCbCtx(data: string): CallbackCtx & { replies: Array<{ text: string; kb?: Keyboard }>; edits: string[] } {
  const replies: Array<{ text: string; kb?: Keyboard }> = [];
  const edits: string[] = [];
  return {
    tgId: 42,
    data,
    replies,
    edits,
    async answer() { /* noop */ },
    async editText(m) { edits.push(m); },
    async reply(m, kb) { replies.push({ text: m, ...(kb ? { kb } : {}) }); },
  };
}

describe("withdraw note picker", () => {
  const dest = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

  it("renders one Send button per note + Cancel", () => {
    const v = renderWithdrawNotes(dest, [30_000_000n, 20_000_000n], 2);
    expect(v.text).toMatch(/Send to: DezXAZ…B263/);
    const labels = v.keyboard.flat().map((b) => b.text);
    expect(labels).toContain("Send 0.0300 SOL");
    expect(labels).toContain("Send 0.0200 SOL");
    expect(labels).toContain("Cancel");
    expect(v.keyboard.flat().find((b) => b.text === "Cancel")!.callbackData).toBe("wd:cancel");
  });

  it("presentWithdrawNotes rejects a malformed address and re-arms", async () => {
    const flow = makeFlowState();
    const ctx = makeCtx();
    const deps = { ...baseDeps, wallet: {
      getHoldings: async () => [],
      cashout: async () => ({ txSignature: "" }),
      getNotes: async () => [{ id: "n1", mint: "So11111111111111111111111111111111111111112", amount: 10_000_000n }],
    }};
    await presentWithdrawNotes(deps, flow, ctx, "not-an-address");
    expect(ctx.replies[0]).toMatch(/doesn't look like a Solana address/);
    expect(flow.awaitWithdrawDest.has(42)).toBe(true); // re-armed for retry
  });

  it("onWithdrawNote unshields to the stored dest + records the tx for verify", async () => {
    const flow = makeFlowState();
    flow.withdrawFlow.set(42, {
      dest,
      notes: [{ id: "note-A", amount: 30_000_000n }, { id: "note-B", amount: 20_000_000n }],
    });
    const cashout = vi.fn(async () => ({ txSignature: "WSIG" }));
    const deps = { ...baseDeps, wallet: { getHoldings: async () => [], cashout } };
    await onWithdrawNote(deps, flow, makeCbCtx("wd:note:1"));
    expect(cashout).toHaveBeenCalledWith({ tgId: 42, recipient: dest });
    expect(flow.lastTxSig.get(42)).toBe("WSIG"); // tracked for Verify privacy
    expect(flow.withdrawFlow.has(42)).toBe(false); // torn down
  });

  it("onWithdrawNote rejects a stale index", async () => {
    const flow = makeFlowState(); // no withdrawFlow for 42
    const cashout = vi.fn(async () => ({ txSignature: "X" }));
    const deps = { ...baseDeps, wallet: { getHoldings: async () => [], cashout } };
    await onWithdrawNote(deps, flow, makeCbCtx("wd:note:0"));
    expect(cashout).not.toHaveBeenCalled();
  });
});

describe("holdings PnL", () => {
  it("renders a green PnL line when value > invested", () => {
    const v = renderHoldings([
      { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", amount: "1000000", decimals: 6, symbol: "BAGS",
        valueLamports: 15_000_000n, investedLamports: 10_000_000n },
    ]);
    expect(v.text).toMatch(/≈ 0\.015000 SOL/);
    expect(v.text).toMatch(/PnL: \+0\.005000 SOL\s+\(\+50\.0%\)/);
  });

  it("renders a red PnL line when value < invested", () => {
    const v = renderHoldings([
      { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", amount: "1000000", decimals: 6, symbol: "BAGS",
        valueLamports: 4_000_000n, investedLamports: 10_000_000n },
    ]);
    expect(v.text).toMatch(/PnL: -0\.006000 SOL\s+\(-60\.0%\)/);
  });

  it("omits PnL when cost basis is unknown (SDK-only fallback)", () => {
    const v = renderHoldings([
      { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", amount: "1000000", decimals: 6 },
    ]);
    expect(v.text).not.toMatch(/PnL:/);
    expect(v.keyboard.flat()[0]!.text).toBe("Sell DezXAZ…B263");
  });
});

describe("buy panel — CLI fast-path", () => {
  it("rejects an unparseable mint", async () => {
    const ctx = makeCtx(`/buy onlyone`);
    await runBuy(baseDeps, makeBuyDeps(), makeFlowState(), ctx);
    expect(ctx.replies[0]).toMatch(/could not extract a mint/);
  });

  it("rejects amount below MIN_TRADE_LAMPORTS", async () => {
    const ctx = makeCtx(`/buy DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 0.0000001`);
    await runBuy(baseDeps, makeBuyDeps(), makeFlowState(), ctx);
    expect(ctx.replies[0]).toMatch(/minimum trade size/);
  });

  it("renders the receipt on success", async () => {
    const ctx = makeCtx(`/buy DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 0.01`);
    const exec = vi.fn(async () => ({
      ok: true as const, txSignature: "abc",
      tokensReceived: 123_456n, effectiveLamports: 10_000_000n,
    }));
    await runBuy(baseDeps, makeBuyDeps({ executeBuy: exec }), makeFlowState(), ctx);
    expect(ctx.replies[0]).toMatch(/sig: abc/);
    expect(ctx.replies[0]).toMatch(/spent 0\.0100 SOL/);
  });
});

describe("sell panel — CLI fast-path", () => {
  const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

  it("tells the user when executeSell isn't wired", async () => {
    const ctx = makeCtx(`/sell ${mint} 1000`);
    await runSell(baseDeps, makeSellDeps(), makeFlowState(), ctx);
    expect(ctx.replies[0]).toMatch(/sell backend not wired/);
  });

  it("a menu tap ('🔴 Sell') opens the token list, NOT the usage error", async () => {
    // Regression: "🔴 Sell".split(/\s+/).slice(1) === ["Sell"] (length 1),
    // which used to hit the 1-arg usage branch. Menu taps must show the list.
    const ctx = makeCtx("🔴 Sell");
    const sell = makeSellDeps({ holdings: async () => [
      { mint, amount: "1000000", decimals: 6, symbol: "BAGS" },
    ]});
    await runSell(baseDeps, sell, makeFlowState(), ctx);
    expect(ctx.replies[0]).not.toMatch(/usage/);
    expect(ctx.replies[0]).toMatch(/Sell which token|BAGS/);
  });

  it("openSellTokenList renders the holdings as a picker", async () => {
    const ctx = makeCtx();
    const sell = makeSellDeps({ holdings: async () => [
      { mint, amount: "1000000", decimals: 6, symbol: "BAGS" },
    ]});
    await openSellTokenList(sell, ctx);
    expect(ctx.replies[0]).toMatch(/BAGS/);
  });

  it("executes a one-shot sell and renders the receipt", async () => {
    const ctx = makeCtx(`/sell ${mint} 1000`);
    const exec = vi.fn(async () => ({ ok: true as const, txSignature: "zzz", solReceived: 2_500_000n }));
    await runSell(baseDeps, makeSellDeps({ executeSell: exec }), makeFlowState(), ctx);
    expect(exec).toHaveBeenCalledWith({ tgId: 42, mint, rawAmount: 1000n });
    expect(ctx.replies[0]).toMatch(/sig: zzz/);
    expect(ctx.replies[0]).toMatch(/0\.002500 SOL/);
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
