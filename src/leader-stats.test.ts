/**
 * leader-stats — pure parser + FIFO matcher. Helius fetch is hit at the
 * boundary so the unit tests build synthetic enhanced-tx payloads and
 * verify both the events.swap path and the transfer-array fallback.
 */
import { describe, it, expect } from "vitest";
import {
  parseAction,
  computeStats,
  type HeliusEnhancedTx,
  WSOL_MINT,
} from "./leader-stats.js";
import { topRecommended, RECOMMENDED_LEADERS } from "./discover-leaders.js";

const WALLET = "Fwallet11111111111111111111111111111111111";
const MINT_A = "MintAAAA1111111111111111111111111111111111";

function jupiterBuy(ts: number, sig: string, solLamports: string, rawOut: string): HeliusEnhancedTx {
  return {
    signature: sig, slot: 1, timestamp: ts, feePayer: WALLET, type: "SWAP",
    events: {
      swap: {
        nativeInput: { account: WALLET, amount: solLamports },
        tokenOutputs: [{ userAccount: WALLET, mint: MINT_A, rawTokenAmount: { tokenAmount: rawOut, decimals: 6 } }],
      },
    },
  };
}
function jupiterSell(ts: number, sig: string, solLamports: string, rawIn: string): HeliusEnhancedTx {
  return {
    signature: sig, slot: 2, timestamp: ts, feePayer: WALLET, type: "SWAP",
    events: {
      swap: {
        nativeOutput: { account: WALLET, amount: solLamports },
        tokenInputs: [{ userAccount: WALLET, mint: MINT_A, rawTokenAmount: { tokenAmount: rawIn, decimals: 6 } }],
      },
    },
  };
}

describe("leader-stats.parseAction", () => {
  it("classifies a Jupiter SOL→mint as buy", () => {
    const tx = jupiterBuy(1700, "sig-1", "10000000", "5000000");
    const a = parseAction(tx, WALLET);
    expect(a.kind).toBe("buy");
    expect(a.mint).toBe(MINT_A);
    expect(a.solLamports).toBe(10_000_000n);
    expect(a.rawTokens).toBe(5_000_000n);
  });

  it("classifies a Jupiter mint→SOL as sell", () => {
    const tx = jupiterSell(1800, "sig-2", "20000000", "5000000");
    const a = parseAction(tx, WALLET);
    expect(a.kind).toBe("sell");
    expect(a.solLamports).toBe(20_000_000n);
  });

  it("returns other when the wallet isn't the feePayer", () => {
    const tx = jupiterBuy(1700, "sig-x", "10000000", "5000000");
    tx.feePayer = "SomeoneElse1111111111111111111111111111111";
    expect(parseAction(tx, WALLET).kind).toBe("other");
  });

  it("falls back to transfer arrays for non-events.swap (pump.fun shape)", () => {
    const tx: HeliusEnhancedTx = {
      signature: "pump-1",
      slot: 3,
      timestamp: 2000,
      feePayer: WALLET,
      type: "SWAP",
      nativeTransfers: [
        { fromUserAccount: WALLET, toUserAccount: "POOL", amount: "1000000" },
      ],
      tokenTransfers: [
        {
          fromUserAccount: "POOL", toUserAccount: WALLET,
          tokenAmount: 0.5, mint: MINT_A,
          rawTokenAmount: { tokenAmount: "500000", decimals: 6 },
        },
      ],
    };
    const a = parseAction(tx, WALLET);
    expect(a.kind).toBe("buy");
    expect(a.solLamports).toBe(1_000_000n);
    expect(a.rawTokens).toBe(500_000n);
  });

  it("ignores wSOL token transfers (treated as part of the SOL leg)", () => {
    // Same shape as the Jupiter buy, but the token out is wSOL — should fall
    // through to "no real token credited" and return other.
    const tx: HeliusEnhancedTx = {
      signature: "wsol-1", slot: 1, timestamp: 1700, feePayer: WALLET, type: "SWAP",
      events: {
        swap: {
          nativeInput: { account: WALLET, amount: "10000000" },
          tokenOutputs: [{ userAccount: WALLET, mint: WSOL_MINT, rawTokenAmount: { tokenAmount: "10000000", decimals: 9 } }],
        },
      },
    };
    expect(parseAction(tx, WALLET).kind).toBe("other");
  });
});

describe("leader-stats.computeStats", () => {
  it("FIFO-matches buys to sells, computing closed PnL", () => {
    const buys = [
      parseAction(jupiterBuy(1000, "b1", "10000000", "1000000"), WALLET),
      parseAction(jupiterBuy(2000, "b2", "10000000", "1000000"), WALLET),
    ];
    const sells = [
      // Sells the first 1M tokens for 15M lamports — closed lot #1 = +5M.
      parseAction(jupiterSell(3000, "s1", "15000000", "1000000"), WALLET),
    ];
    const stats = computeStats(WALLET, [...buys, ...sells], 86_400);
    expect(stats.buys).toBe(2);
    expect(stats.sells).toBe(1);
    expect(stats.closed.length).toBe(1);
    expect(stats.closed[0]!.pnlLamports).toBe(5_000_000n);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(0);
    expect(stats.winRatePct).toBe(100);
    expect(stats.netClosedSolLamports).toBe(5_000_000n);
    // total buy volume = both buys
    expect(stats.totalBuyVolumeLamports).toBe(20_000_000n);
  });

  it("returns null win-rate and best/worst when there are no closes", () => {
    const buys = [parseAction(jupiterBuy(1000, "b1", "10000000", "1000000"), WALLET)];
    const stats = computeStats(WALLET, buys, 86_400);
    expect(stats.winRatePct).toBe(null);
    expect(stats.bestTrade).toBe(null);
    expect(stats.worstTrade).toBe(null);
    expect(stats.avgHoldSecs).toBe(null);
  });

  it("pro-rates a partial sell against the open buy lot", () => {
    const actions = [
      parseAction(jupiterBuy(1000, "b1", "10000000", "1000000"), WALLET),
      // Sell half the lot for 7M — half the lot cost = 5M, so PnL = +2M.
      parseAction(jupiterSell(2000, "s1", "7000000", "500000"), WALLET),
    ];
    const stats = computeStats(WALLET, actions, 86_400);
    expect(stats.closed.length).toBe(1);
    expect(stats.closed[0]!.buySolLamports).toBe(5_000_000n);
    expect(stats.closed[0]!.sellSolLamports).toBe(7_000_000n);
    expect(stats.closed[0]!.pnlLamports).toBe(2_000_000n);
  });
});

describe("discover-leaders", () => {
  it("topRecommended returns at most N entries", () => {
    expect(topRecommended(3).length).toBe(3);
    expect(topRecommended(99).length).toBe(RECOMMENDED_LEADERS.length);
  });

  it("every recommended leader has a non-empty wallet, label, and blurb", () => {
    for (const r of RECOMMENDED_LEADERS) {
      expect(r.wallet.length).toBeGreaterThanOrEqual(32);
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.blurb.length).toBeGreaterThan(0);
    }
  });
});
