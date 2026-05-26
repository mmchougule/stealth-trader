/**
 * Buy panel — inline keyboard render + callback flow.
 *
 * The render functions are pure, so we assert on the exact button layout
 * (note pagination, % chips, the 🔒/🌐 markers). The callbacks are driven
 * through a recording CallbackCtx that captures answers + edits + replies,
 * so we verify the panel → preview → execute → receipt path without grammy.
 */
import { describe, it, expect, vi } from "vitest";

// Controllable rugcheck mock — defaults to pass:true so the rest of the
// suite is unaffected; the danger test overrides per-call. Resolves to the
// same module buy.ts imports ("../../safety.js") — vitest dedupes by path.
const safetyMock = vi.hoisted(() => ({
  checkToken: vi.fn(async () => ({ pass: true, reason: "ok" })),
}));
vi.mock("../safety.js", () => safetyMock);

import {
  renderBuyPanel,
  renderBuyPreview,
  runBuy,
  onBuyNote,
  onBuyAmount,
  onBuyConfirm,
  onBuyCancel,
  onBuyNotesMore,
  parseSolAmount,
  type BuyDeps,
} from "./panels/buy.js";
import { makeFlowState, type BuyFlow } from "./state.js";
import type { CallbackCtx, CommandCtx, Deps, Keyboard } from "./types.js";

function makeCmdCtx(text: string): CommandCtx & { replies: string[] } {
  const replies: string[] = [];
  return { tgId: 7, text, replies, async reply(m) { replies.push(m); } };
}

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SOL = 1_000_000_000n;

function makeCbCtx(data: string): CallbackCtx & {
  answers: (string | undefined)[];
  edits: Array<{ text: string; kb?: Keyboard }>;
  sent: Array<{ text: string; kb?: Keyboard }>;
} {
  const answers: (string | undefined)[] = [];
  const edits: Array<{ text: string; kb?: Keyboard }> = [];
  const sent: Array<{ text: string; kb?: Keyboard }> = [];
  return {
    tgId: 7,
    data,
    answers,
    edits,
    sent,
    async answer(t) { answers.push(t); },
    async editText(text, kb) { edits.push({ text, kb }); },
    async reply(text, kb) { sent.push({ text, kb }); },
  };
}

function makeBuyDeps(over: Partial<BuyDeps> = {}): BuyDeps {
  return {
    executeBuy: async () => ({ ok: true as const, txSignature: "sig", tokensReceived: 0n, effectiveLamports: 0n }),
    publicSolLamports: async () => 0n,
    shieldedSolNotes: async () => [],
    tokenMeta: async () => ({ symbol: null, decimals: 6 }),
    quoteTokensOut: async () => null,
    computeBuyFee: () => 300_000n,
    ...over,
  };
}

/** Flatten a keyboard to button labels for terse assertions. */
const labels = (kb: Keyboard): string[] => kb.flat().map((b) => b.text);
const datas = (kb: Keyboard): string[] => kb.flat().map((b) => b.callbackData ?? b.url ?? "");

describe("renderBuyPanel", () => {
  it("shows both PRIVATE and PUBLIC sections with marker prefixes", () => {
    const v = renderBuyPanel({
      mint: MINT,
      symbol: "BAGS",
      publicSolLamports: 1n * SOL,
      shieldedNotes: [50_000_000n, 76_900_000n],
      rugScore: 0,
      noteOffset: 0,
    });
    expect(v.text).toMatch(/🔒 PRIVATE/);
    expect(v.text).toMatch(/🌐 PUBLIC/);
    expect(v.text).toMatch(/rugcheck: safe \(0\)/);
    // Notes are largest-first.
    expect(v.notes).toEqual([76_900_000n, 50_000_000n]);
    const ls = labels(v.keyboard);
    expect(ls.some((l) => l.startsWith("🔒 0.0769"))).toBe(true);
    expect(ls.some((l) => l.startsWith("🌐"))).toBe(true);
    expect(ls).toContain("Cancel");
  });

  it("paginates notes 2-at-a-time with a More button", () => {
    const notes = [9n, 8n, 7n, 6n, 5n].map((n) => n * 10_000_000n);
    const v = renderBuyPanel({
      mint: MINT, symbol: null, publicSolLamports: 0n,
      shieldedNotes: notes, rugScore: undefined, noteOffset: 0,
    });
    const noteBtns = v.keyboard.flat().filter((b) => b.callbackData?.startsWith("buy:note:"));
    expect(noteBtns).toHaveLength(2); // only NOTES_PER_PAGE shown
    const more = v.keyboard.flat().find((b) => b.callbackData?.startsWith("buy:notes:more:"));
    expect(more?.text).toMatch(/More notes \(3 more\)/);
    expect(more?.callbackData).toBe("buy:notes:more:2");
  });

  it("drops notes below the min trade size and hides empty sections", () => {
    const v = renderBuyPanel({
      mint: MINT, symbol: null,
      publicSolLamports: 1_000n, // below reserve → no public chips
      shieldedNotes: [500_000n], // below MIN_TRADE_LAMPORTS → dropped
      rugScore: undefined, noteOffset: 0,
    });
    expect(v.notes).toEqual([]);
    expect(v.text).toMatch(/Not enough SOL/);
    expect(datas(v.keyboard).filter((d) => d.startsWith("buy:"))).toEqual(["buy:cancel"]);
  });

  it("renders % chips as exact-lamports callbacks of usable balance", () => {
    // 1 SOL public, 0.003 reserve → 0.997 usable. 25% = 0.24925 SOL.
    const v = renderBuyPanel({
      mint: MINT, symbol: null, publicSolLamports: 1n * SOL,
      shieldedNotes: [], rugScore: undefined, noteOffset: 0,
    });
    const chips = v.keyboard.flat().filter((b) => b.callbackData?.startsWith("buy:amt:"));
    expect(chips.map((c) => c.callbackData)).toEqual([
      "buy:amt:249250000", "buy:amt:498500000", "buy:amt:747750000", "buy:amt:997000000",
    ]);
    expect(chips[3]!.text).toMatch(/Max/);
  });
});

describe("renderBuyPreview", () => {
  it("renders spend / get / fee / total from the same lamports", () => {
    const v = renderBuyPreview({
      symbol: "BAGS", solLamports: 10_000_000n, feeLamports: 305_000n,
      estTokensOut: 123_456n, decimals: 6, // ~0.123 tokens
    });
    expect(v.text).toMatch(/Spend:  0\.0100 SOL/);
    expect(v.text).toMatch(/Fee:    0\.000305 SOL/);
    expect(v.text).toMatch(/Total:  0\.0103 SOL/);
    expect(datas(v.keyboard)).toEqual(["buy:confirm", "buy:cancel"]);
  });

  it("shows ~? when the quote is unavailable", () => {
    const v = renderBuyPreview({
      symbol: null, solLamports: SOL, feeLamports: 0n, estTokensOut: null, decimals: 6,
    });
    expect(v.text).toMatch(/Get:    ~\?/);
  });
});

describe("buy callbacks", () => {
  it("buy:note → preview using the exact stored note size", async () => {
    const state = makeFlowState();
    const flow: BuyFlow = {
      mint: MINT, symbol: "BAGS", decimals: 6, tab: "notes", noteOffset: 0,
      notes: [76_900_000n, 50_000_000n],
    };
    state.buyFlow.set(7, flow);
    const quote = vi.fn(async () => 999n);
    const ctx = makeCbCtx("buy:note:0");
    await onBuyNote(makeBuyDeps({ quoteTokensOut: quote }), state, ctx);
    expect(quote).toHaveBeenCalledWith(MINT, 76_900_000n, 6);
    // Preview replaced the panel; pendingBuy now armed, buyFlow cleared.
    expect(ctx.edits[0]!.text).toMatch(/Buy preview/);
    expect(state.pendingBuy.get(7)!.solLamports).toBe(76_900_000n);
    expect(state.buyFlow.has(7)).toBe(false);
  });

  it("buy:note with a stale index answers + does not preview", async () => {
    const state = makeFlowState();
    state.buyFlow.set(7, { mint: MINT, symbol: null, decimals: 6, tab: "notes", noteOffset: 0, notes: [SOL] });
    const ctx = makeCbCtx("buy:note:9");
    await onBuyNote(makeBuyDeps(), state, ctx);
    expect(ctx.answers[0]).toMatch(/expired/);
    expect(ctx.edits).toHaveLength(0);
  });

  it("buy:amt parses lamports from callback data into the preview", async () => {
    const state = makeFlowState();
    state.buyFlow.set(7, { mint: MINT, symbol: null, decimals: 6, tab: "public", noteOffset: 0, notes: [] });
    const ctx = makeCbCtx("buy:amt:249250000");
    await onBuyAmount(makeBuyDeps(), state, ctx);
    expect(state.pendingBuy.get(7)!.solLamports).toBe(249_250_000n);
  });

  it("buy:confirm routes through executeBuy and renders a receipt", async () => {
    const state = makeFlowState();
    state.pendingBuy.set(7, { mint: MINT, symbol: "BAGS", solLamports: 10_000_000n, decimals: 6 });
    const exec = vi.fn(async () => ({
      ok: true as const, txSignature: "TX9", tokensReceived: 5_000_000n, effectiveLamports: 10_000_000n,
    }));
    const ctx = makeCbCtx("buy:confirm");
    await onBuyConfirm(makeBuyDeps({ executeBuy: exec }), state, ctx);
    expect(exec).toHaveBeenCalledWith({ tgId: 7, mint: MINT, solLamports: 10_000_000n });
    expect(ctx.sent[0]!.text).toMatch(/Bought .* \$BAGS/);
    expect(ctx.sent[0]!.kb![0]![0]!.url).toBe("https://solscan.io/tx/TX9");
    expect(state.pendingBuy.has(7)).toBe(false);
  });

  it("buy:confirm surfaces a failure without throwing", async () => {
    const state = makeFlowState();
    state.pendingBuy.set(7, { mint: MINT, symbol: null, solLamports: SOL, decimals: 6 });
    const ctx = makeCbCtx("buy:confirm");
    await onBuyConfirm(makeBuyDeps({ executeBuy: async () => ({ ok: false as const, error: "no route" }) }), state, ctx);
    expect(ctx.sent[0]!.text).toMatch(/buy failed: no route/);
  });

  it("buy:confirm with no pending preview answers expired", async () => {
    const state = makeFlowState();
    const ctx = makeCbCtx("buy:confirm");
    await onBuyConfirm(makeBuyDeps(), state, ctx);
    expect(ctx.answers[0]).toMatch(/expired/);
  });

  it("CLI buy aborts on a rugcheck danger verdict (no SOL moves)", async () => {
    safetyMock.checkToken.mockResolvedValueOnce({
      pass: false, reason: "RugCheck danger flags: honeypot",
    });
    const exec = vi.fn(async () => ({
      ok: true as const, txSignature: "TX", tokensReceived: 0n, effectiveLamports: 0n,
    }));
    const ctx = makeCmdCtx(`/buy ${MINT} 0.01`);
    await runBuy({} as Deps, makeBuyDeps({ executeBuy: exec }), makeFlowState(), ctx);
    expect(exec).not.toHaveBeenCalled();
    expect(ctx.replies[0]).toMatch(/blocked: RugCheck danger/);
  });

  it("double-tapped buy:confirm executes exactly once", async () => {
    // Telegram resends callbacks; pendingBuy is deleted BEFORE the await,
    // so a second tap finds no pending and short-circuits to "expired".
    const state = makeFlowState();
    state.pendingBuy.set(7, { mint: MINT, symbol: "BAGS", solLamports: SOL, decimals: 6 });
    let inflight = false;
    const exec = vi.fn(async () => {
      // Assert the two calls never overlap (pending cleared before await).
      expect(inflight).toBe(false);
      inflight = true;
      await new Promise((r) => setTimeout(r, 5));
      inflight = false;
      return { ok: true as const, txSignature: "TX1", tokensReceived: 1n, effectiveLamports: SOL };
    });
    const deps = makeBuyDeps({ executeBuy: exec });
    await Promise.all([
      onBuyConfirm(deps, state, makeCbCtx("buy:confirm")),
      onBuyConfirm(deps, state, makeCbCtx("buy:confirm")),
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("buy:cancel clears state and edits the message", async () => {
    const state = makeFlowState();
    state.buyFlow.set(7, { mint: MINT, symbol: null, decimals: 6, tab: "notes", noteOffset: 0, notes: [] });
    state.pendingBuy.set(7, { mint: MINT, symbol: null, solLamports: SOL, decimals: 6 });
    const ctx = makeCbCtx("buy:cancel");
    await onBuyCancel(state, ctx);
    expect(state.buyFlow.has(7)).toBe(false);
    expect(state.pendingBuy.has(7)).toBe(false);
    expect(ctx.edits[0]!.text).toBe("Cancelled.");
  });

  it("buy:notes:more advances the paginator and re-renders", async () => {
    const state = makeFlowState();
    const notes = [9n, 8n, 7n, 6n].map((n) => n * 10_000_000n);
    state.buyFlow.set(7, { mint: MINT, symbol: null, decimals: 6, tab: "notes", noteOffset: 0, notes });
    const ctx = makeCbCtx("buy:notes:more:2");
    await onBuyNotesMore(makeBuyDeps({ shieldedSolNotes: async () => notes }), state, ctx);
    expect(state.buyFlow.get(7)!.noteOffset).toBe(2);
    expect(ctx.edits[0]!.text).toMatch(/🔒 PRIVATE/);
  });
});

describe("parseSolAmount", () => {
  it("parses integer and fractional SOL to lamports", () => {
    expect(parseSolAmount("1")).toBe(SOL);
    expect(parseSolAmount("0.01")).toBe(10_000_000n);
  });
  it("rejects non-numeric input", () => {
    expect(parseSolAmount("abc")).toBeNull();
    expect(parseSolAmount("")).toBeNull();
  });
});
