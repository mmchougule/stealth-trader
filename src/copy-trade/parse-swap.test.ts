/**
 * Contract for parseSwap. The pipeline depends on these invariants:
 *   - feePayer != watchedWallet      → null
 *   - net SOL out of watched ≤ 0     → null
 *   - no non-wSOL credit to watched  → null
 *   - happy path returns ParsedSwap with amounts from transfers, NOT events
 *
 * The "transfers are ground truth" cases are the bug-class that motivated
 * dropping events.swap entirely (see real-world pump.fun-via-Jupiter case).
 */
import { describe, it, expect } from "vitest";
import { parseSwap, parseBatch } from "./parse-swap.js";
import { WSOL_MINT } from "./types.js";
import type { HeliusEnhancedTx } from "./types.js";

const LEADER = "8Sn7Z9wXSp7sH8GJk73Lp9wXSp7sH8GJk73Lp9wXSp77";
const OTHER  = "BSn7Z9wXSp7sH8GJk73Lp9wXSp7sH8GJk73Lp9wXSp78";
const PUMP   = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const USDC   = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function buy(opts: {
  feePayer?: string;
  natSolOut?: bigint;
  wsolOut?: bigint;
  outputs?: Array<{ to: string; mint: string; raw?: string; decimals?: number; amount?: number }>;
}): HeliusEnhancedTx {
  const tokenTransfers: NonNullable<HeliusEnhancedTx["tokenTransfers"]> = [];
  const nativeTransfers: NonNullable<HeliusEnhancedTx["nativeTransfers"]> = [];
  if (opts.natSolOut) {
    nativeTransfers.push({ fromUserAccount: LEADER, toUserAccount: OTHER, amount: Number(opts.natSolOut) });
  }
  if (opts.wsolOut) {
    tokenTransfers.push({
      fromUserAccount: LEADER,
      toUserAccount: OTHER,
      mint: WSOL_MINT,
      tokenAmount: Number(opts.wsolOut) / 1e9,
      rawTokenAmount: { tokenAmount: opts.wsolOut.toString(), decimals: 9 },
    });
  }
  for (const o of opts.outputs ?? [{ to: LEADER, mint: PUMP, raw: "1000000", decimals: 6 }]) {
    tokenTransfers.push({
      fromUserAccount: OTHER,
      toUserAccount: o.to,
      mint: o.mint,
      tokenAmount: o.amount ?? (o.raw ? Number(o.raw) / 10 ** (o.decimals ?? 6) : 0),
      ...(o.raw ? { rawTokenAmount: { tokenAmount: o.raw, decimals: o.decimals ?? 6 } } : {}),
    });
  }
  return {
    signature: "sig-test",
    slot: 100,
    feePayer: opts.feePayer ?? LEADER,
    type: "SWAP",
    source: "JUPITER",
    events: {},
    nativeTransfers,
    tokenTransfers,
  };
}

describe("parseSwap — positive", () => {
  it("parses a native-SOL Jupiter buy", () => {
    const p = parseSwap(buy({ natSolOut: 1_000_000_000n }), LEADER);
    expect(p).not.toBeNull();
    expect(p!.tokenIn).toBe(WSOL_MINT);
    expect(p!.tokenOut).toBe(PUMP);
    expect(p!.amountIn).toBe(1_000_000_000n);
  });

  it("parses a wSOL-leg-only Jupiter buy (Phantom-style swap)", () => {
    // Real mainnet shape: leader sends out a wSOL SPL transfer, no native
    // SOL transfer for the swap leg. Without summing wSOL out, this returns
    // null and the copy is lost.
    const p = parseSwap(buy({ wsolOut: 275_000_000n }), LEADER);
    expect(p).not.toBeNull();
    expect(p!.amountIn).toBe(275_000_000n);
  });

  it("sums native + wSOL legs when both present (Jupiter pump.fun route)", () => {
    const p = parseSwap(buy({ natSolOut: 800_000n, wsolOut: 274_000_000n }), LEADER);
    expect(p).not.toBeNull();
    expect(p!.amountIn).toBe(274_800_000n);
  });

  it("picks the largest non-wSOL credited output across multi-hop routes", () => {
    const p = parseSwap(
      buy({
        natSolOut: 500_000_000n,
        outputs: [
          { to: LEADER, mint: USDC, amount: 0.001 },
          { to: LEADER, mint: PUMP, amount: 1000 },
        ],
      }),
      LEADER,
    );
    expect(p!.tokenOut).toBe(PUMP);
  });

  it("ignores wSOL credits to the leader (those are unwraps, not buys)", () => {
    const p = parseSwap(
      buy({
        natSolOut: 500_000_000n,
        outputs: [
          { to: LEADER, mint: WSOL_MINT, amount: 5 },
          { to: LEADER, mint: PUMP, amount: 1 },
        ],
      }),
      LEADER,
    );
    expect(p!.tokenOut).toBe(PUMP);
  });
});

describe("parseSwap — rejection", () => {
  it("rejects when feePayer != watched", () => {
    expect(parseSwap(buy({ feePayer: OTHER, natSolOut: 1_000_000_000n }), LEADER)).toBeNull();
  });

  it("rejects when net SOL out is zero or negative (incoming swap)", () => {
    const tx: HeliusEnhancedTx = {
      signature: "x", slot: 1, feePayer: LEADER, type: "SWAP",
      events: {},
      nativeTransfers: [
        { fromUserAccount: LEADER, toUserAccount: OTHER, amount: 1_000_000 },
        { fromUserAccount: OTHER, toUserAccount: LEADER, amount: 2_000_000 },
      ],
      tokenTransfers: [
        { fromUserAccount: OTHER, toUserAccount: LEADER, mint: PUMP, tokenAmount: 1, rawTokenAmount: { tokenAmount: "1", decimals: 6 } },
      ],
    };
    expect(parseSwap(tx, LEADER)).toBeNull();
  });

  it("rejects when no non-wSOL token is credited to the leader", () => {
    const tx: HeliusEnhancedTx = {
      signature: "x", slot: 1, feePayer: LEADER, type: "SWAP",
      events: {},
      nativeTransfers: [{ fromUserAccount: LEADER, toUserAccount: OTHER, amount: 1_000_000 }],
      tokenTransfers: [],
    };
    expect(parseSwap(tx, LEADER)).toBeNull();
  });

  it("accepts TRANSFER-typed txs whose transfer shape is a buy", () => {
    // Helius classifier sometimes mislabels Phantom in-app swaps + custom
    // routers as type=TRANSFER. We don't gate on tx.type — transfers decide.
    const tx = { ...buy({ wsolOut: 100_000_000n }), type: "TRANSFER" as const };
    expect(parseSwap(tx, LEADER)).not.toBeNull();
  });
});

describe("parseBatch", () => {
  it("filters to buys by the watched wallet only", () => {
    const txs = [
      { ...buy({ natSolOut: 1n }), signature: "ok-1" },
      { ...buy({ feePayer: OTHER, natSolOut: 1n }), signature: "skip" },
      { ...buy({ natSolOut: 1n }), signature: "ok-2" },
    ];
    const out = parseBatch(txs, LEADER);
    expect(out.map((p) => p.signature)).toEqual(["ok-1", "ok-2"]);
  });

  it("returns [] for empty input", () => {
    expect(parseBatch([], LEADER)).toEqual([]);
  });
});
