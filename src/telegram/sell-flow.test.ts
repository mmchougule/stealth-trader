/**
 * Sell panel — inline keyboard render + callback flow.
 *
 * Pure renderers assert the token-picker + per-token note list layout; the
 * callbacks are driven through a recording CallbackCtx to verify
 * mint → note → preview → confirm → receipt without grammy.
 */
import { describe, it, expect, vi } from "vitest";
import {
  renderSellTokenList,
  renderSellNotes,
  renderSellPreview,
  onSellMint,
  onSellNote,
  onSellConfirm,
  onSellCancel,
  type SellDeps,
} from "./panels/sell.js";
import { makeFlowState } from "./state.js";
import type { CallbackCtx, Keyboard } from "./types.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function makeCbCtx(data: string): CallbackCtx & {
  answers: (string | undefined)[];
  edits: Array<{ text: string; kb?: Keyboard }>;
  sent: Array<{ text: string; kb?: Keyboard }>;
} {
  const answers: (string | undefined)[] = [];
  const edits: Array<{ text: string; kb?: Keyboard }> = [];
  const sent: Array<{ text: string; kb?: Keyboard }> = [];
  return {
    tgId: 7, data, answers, edits, sent,
    async answer(t) { answers.push(t); },
    async editText(text, kb) { edits.push({ text, kb }); },
    async reply(text, kb) { sent.push({ text, kb }); },
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

const datas = (kb: Keyboard): string[] => kb.flat().map((b) => b.callbackData ?? b.url ?? "");

describe("renderSellTokenList", () => {
  it("renders one Sell button per holding keyed by mint", () => {
    const v = renderSellTokenList([
      { mint: MINT, amount: "1500000", decimals: 6, symbol: "BAGS" },
    ]);
    expect(v.text).toMatch(/BAGS: 1\.5/);
    expect(datas(v.keyboard)).toEqual([`sell:mint:${MINT}`]);
  });

  it("falls back to a hint when there are no holdings", () => {
    const v = renderSellTokenList([]);
    expect(v.text).toMatch(/no shielded holdings/);
    expect(v.keyboard).toEqual([]);
  });
});

describe("renderSellNotes", () => {
  it("shows the top 3 notes largest-first, one tappable per note", () => {
    const v = renderSellNotes({
      mint: MINT, symbol: "BAGS", decimals: 6,
      notes: [1n, 5n, 3n, 2n, 4n].map((n) => n * 1_000_000n),
    });
    expect(v.shown).toEqual([5_000_000n, 4_000_000n, 3_000_000n]);
    expect(datas(v.keyboard)).toEqual(["sell:note:0", "sell:note:1", "sell:note:2", "sell:cancel"]);
  });

  it("reports nothing-spendable when there are no notes", () => {
    const v = renderSellNotes({ mint: MINT, symbol: null, decimals: 6, notes: [] });
    expect(v.shown).toEqual([]);
    expect(v.text).toMatch(/nothing spendable/);
  });
});

describe("renderSellPreview", () => {
  it("renders sell / get and a remaining-notes note when total exceeds the note", () => {
    const v = renderSellPreview({
      symbol: "BAGS", rawAmount: 2_000_000n, decimals: 6,
      estSolOut: 2_500_000n, totalRaw: 5_000_000n,
    });
    expect(v.text).toMatch(/Get:   ~0\.002500 SOL/);
    expect(v.text).toMatch(/keep 3\.00 BAGS in smaller notes/i);
    expect(datas(v.keyboard)).toEqual(["sell:confirm", "sell:cancel"]);
  });
});

describe("sell callbacks", () => {
  it("sell:mint loads notes and stores the sell flow", async () => {
    const state = makeFlowState();
    const deps = makeSellDeps({
      holdings: async () => [{ mint: MINT, amount: "5000000", decimals: 6, symbol: "BAGS" }],
      tokenNotes: async () => [3_000_000n, 2_000_000n],
    });
    const ctx = makeCbCtx(`sell:mint:${MINT}`);
    await onSellMint(deps, state, ctx);
    const f = state.sellFlow.get(7)!;
    expect(f.notes.map((n) => n.amount)).toEqual([3_000_000n, 2_000_000n]);
    expect(ctx.sent[0]!.text).toMatch(/Sell \$BAGS/);
  });

  it("sell:note arms pendingSell from the stored note", async () => {
    const state = makeFlowState();
    state.sellFlow.set(7, {
      mint: MINT, symbol: "BAGS", decimals: 6,
      notes: [
        { mint: MINT, amount: 3_000_000n, symbol: "BAGS", decimals: 6 },
        { mint: MINT, amount: 2_000_000n, symbol: "BAGS", decimals: 6 },
      ],
    });
    const ctx = makeCbCtx("sell:note:1");
    await onSellNote(makeSellDeps({ quoteSolOut: async () => 500_000n }), state, ctx);
    expect(state.pendingSell.get(7)!.tokenAmount).toBe(2_000_000n);
    expect(state.sellFlow.has(7)).toBe(false);
    expect(ctx.edits[0]!.text).toMatch(/Sell preview/);
  });

  it("sell:note with a stale index answers expired", async () => {
    const state = makeFlowState();
    const ctx = makeCbCtx("sell:note:0");
    await onSellNote(makeSellDeps(), state, ctx);
    expect(ctx.answers[0]).toMatch(/expired/);
  });

  it("sell:confirm executes the private sell and renders a receipt", async () => {
    const state = makeFlowState();
    state.pendingSell.set(7, { mint: MINT, symbol: "BAGS", decimals: 6, tokenAmount: 2_000_000n });
    const exec = vi.fn(async () => ({ ok: true as const, txSignature: "TXS", solReceived: 2_500_000n }));
    const ctx = makeCbCtx("sell:confirm");
    await onSellConfirm(makeSellDeps({ executeSell: exec }), state, ctx);
    expect(exec).toHaveBeenCalledWith({ tgId: 7, mint: MINT, rawAmount: 2_000_000n });
    expect(ctx.sent[0]!.text).toMatch(/Sold for \+0\.002500 SOL/);
    expect(ctx.sent[0]!.kb![0]![0]!.url).toBe("https://solscan.io/tx/TXS");
    expect(state.pendingSell.has(7)).toBe(false);
  });

  it("sell:confirm surfaces a failure without throwing", async () => {
    const state = makeFlowState();
    state.pendingSell.set(7, { mint: MINT, symbol: null, decimals: 6, tokenAmount: 1n });
    const ctx = makeCbCtx("sell:confirm");
    await onSellConfirm(makeSellDeps({ executeSell: async () => ({ ok: false as const, error: "CLMM nested CPI" }) }), state, ctx);
    expect(ctx.sent[0]!.text).toMatch(/sell failed: CLMM nested CPI/);
  });

  it("sell:cancel clears state and edits the message", async () => {
    const state = makeFlowState();
    state.sellFlow.set(7, { mint: MINT, symbol: null, decimals: 6, notes: [] });
    const ctx = makeCbCtx("sell:cancel");
    await onSellCancel(state, ctx);
    expect(state.sellFlow.has(7)).toBe(false);
    expect(ctx.edits[0]!.text).toBe("Cancelled.");
  });
});
