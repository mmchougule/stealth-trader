/**
 * Discover contract:
 *   - empty history → buys=0, pnl=0, score=0
 *   - one buy → buys=1, pnl=-amountIn, score is negative (loss)
 *   - one buy + one sell with profit → score positive, pnl > 0
 *   - scoring is descending: more buys + more profit ranks higher
 *
 * Network is mocked via injected fetchHistory. The parseSwap behaviour
 * is covered in parse-swap.test.ts; here we only test discover wiring.
 */
import { describe, it, expect } from "vitest";
import { makeDiscover, scoreFromCounts } from "./discover.js";
import { WSOL_MINT } from "./copy-trade/types.js";
import type { HeliusEnhancedTx } from "./copy-trade/types.js";

const W1 = "Wallet1111111111111111111111111111111111111";
const MINT = "MintXYZ1111111111111111111111111111111111111";

function buy(amountSol: number): HeliusEnhancedTx {
  return {
    signature: `buy-${amountSol}`, slot: 1, feePayer: W1, type: "SWAP",
    events: {},
    nativeTransfers: [{ fromUserAccount: W1, toUserAccount: "X", amount: amountSol * 1e9 }],
    tokenTransfers: [{
      fromUserAccount: "X", toUserAccount: W1, mint: MINT,
      tokenAmount: 1, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
    }],
  };
}

function sell(amountSol: number): HeliusEnhancedTx {
  return {
    signature: `sell-${amountSol}`, slot: 2, feePayer: W1, type: "SWAP",
    events: {},
    nativeTransfers: [{ fromUserAccount: "X", toUserAccount: W1, amount: amountSol * 1e9 }],
    tokenTransfers: [{
      fromUserAccount: W1, toUserAccount: "X", mint: MINT,
      tokenAmount: 1, rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
    }],
  };
}

describe("makeDiscover", () => {
  it("returns zeros for an empty history", async () => {
    const d = makeDiscover({ fetchHistory: async () => [] });
    const r = await d({ candidates: [W1], lookbackHours: 24 });
    expect(r).toEqual([{ wallet: W1, score: 0, buys: 0, pnlSol: 0 }]);
  });

  it("counts buys and treats SOL spent as negative PnL", async () => {
    const d = makeDiscover({ fetchHistory: async () => [buy(0.5), buy(0.3)] });
    const r = await d({ candidates: [W1], lookbackHours: 24 });
    expect(r[0].buys).toBe(2);
    expect(r[0].pnlSol).toBeCloseTo(-0.8, 5);
    expect(r[0].score).toBeLessThan(0);
  });

  it("adds sell-side SOL credit to PnL", async () => {
    // Bought 0.5 + 0.3 = 0.8 SOL, sold for 1.0 SOL → +0.2 PnL.
    const d = makeDiscover({ fetchHistory: async () => [buy(0.5), buy(0.3), sell(1.0)] });
    const r = await d({ candidates: [W1], lookbackHours: 24 });
    expect(r[0].buys).toBe(2);
    expect(r[0].pnlSol).toBeCloseTo(0.2, 5);
    expect(r[0].score).toBeGreaterThan(0);
  });

  it("returns one row per candidate, preserves input order", async () => {
    const d = makeDiscover({ fetchHistory: async () => [] });
    const r = await d({ candidates: [W1, "Wallet2222222222222222222222222222222222222"], lookbackHours: 24 });
    expect(r.map((s) => s.wallet)).toEqual([W1, "Wallet2222222222222222222222222222222222222"]);
  });
});

describe("scoreFromCounts", () => {
  it("zero-buys + zero-pnl → 0", () => {
    expect(scoreFromCounts(0, 0)).toBe(0);
  });
  it("more buys with same PnL → higher absolute score", () => {
    expect(Math.abs(scoreFromCounts(10, 1))).toBeGreaterThan(Math.abs(scoreFromCounts(2, 1)));
  });
  it("positive PnL → positive score; negative → negative", () => {
    expect(scoreFromCounts(5, 2)).toBeGreaterThan(0);
    expect(scoreFromCounts(5, -2)).toBeLessThan(0);
  });
});

// Silences the unused-import warning when WSOL_MINT shifts.
void WSOL_MINT;
