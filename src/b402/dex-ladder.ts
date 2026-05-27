/**
 * Swap retry ladder — TWO dimensions, ported from the reference trader's
 * executePrivateSwap (mainnet-proven on production copy-trades).
 *
 *   1. dexes        — which Jupiter DEX labels the route may use.
 *   2. maxAccounts  — how many accounts the route may reference.
 *
 * Why both. The b402 swap wraps Jupiter in pool → adapter → Jupiter → DEX.
 * That nesting hits TWO independent on-chain limits:
 *
 *   - 1232 B v0 packet cap → "encoding overruns Uint8Array" / "tx_too_large".
 *     Fix: drop maxAccounts (fewer accounts → smaller tx). SAME dex set.
 *
 *   - CPI call-depth cap → "Cross-program invocation call depth too deep".
 *     A DEX that makes its own sub-CPI (Raydium CLMM → tick array, Meteora
 *     DLMM → bin array, Orca Whirlpool → oracle) pushes the chain past the
 *     limit once wrapped. maxAccounts does NOTHING for this — the only fix
 *     is to route through a FLAT-CPI DEX. So we filter Jupiter to a known-
 *     flat allow-list first, and on a CPI failure narrow further.
 *
 * The previous version of this file kept only the maxAccounts dimension, so
 * Jupiter freely picked a nested DEX for sells and the relayer returned a
 * 502 wrapping "call depth too deep" — which then got mis-classified as a
 * transient route-stale 502 and retried on the same nested route. That is
 * the failure mode this guards against.
 *
 * Transient route-staleness (0x9 SlippageToleranceExceeded, 0x1789
 * RouteStale, a *bare* 502 rpc_failure) still gets a single in-place retry
 * at the same (dexes, maxAccounts) — Jupiter routes refresh in <1s.
 *
 * Other error classes (real on-chain failures, relayer 4xx) bubble up
 * unchanged so the caller's error handler decides policy.
 */
import type { PublicKey } from "@solana/web3.js";

export interface SwapLike {
  swap(opts: {
    inMint: PublicKey;
    outMint: PublicKey;
    amount: bigint;
    maxAccounts?: number;
    slippageBps?: number;
    /** Comma-separated Jupiter DEX labels. Forwarded to the quote so the
     *  route is constrained to these venues. Empty string = no filter. */
    dexes?: string;
  }): Promise<{ signature?: string; sig?: string; outAmount?: bigint | string }>;
}

export interface LadderOptions {
  inMint: PublicKey;
  outMint: PublicKey;
  amount: bigint;
  slippageBps?: number;
  /** Override the maxAccounts ladder. Falls back to env JUP_MAX_ACCOUNTS / [32,28,24,20]. */
  ladder?: number[];
  /** Override the dex ladder. Falls back to dexLadder() below. */
  dexLadderOverride?: string[];
}

/**
 * All-flat-CPI Jupiter DEX labels. Verified against Jupiter's
 * /program-id-to-label endpoint + docs. Excludes any DEX whose swap ix makes
 * an internal CPI to a sub-program (tick array, bin array, oracle) — those
 * exceed the CPI depth cap once wrapped in the b402 swap circuit and fail
 * simulation with "call depth too deep".
 *
 * Known nested, deliberately EXCLUDED: Raydium CLMM, Meteora (DLMM / DAMM
 * v2), Orca Whirlpool. New Jupiter labels default to EXCLUDED until verified.
 */
export const FLAT_CPI_DEXES = [
  "Phoenix",          // orderbook (Ellipsis Labs)
  "Manifest",         // orderbook
  "OpenBook V2",      // orderbook fork
  "Raydium",          // V4 AMM (constant product) — distinct from CLMM
  "Raydium CP",       // newer CPMM, also flat
  "Orca V1",          // pre-Whirlpool AMM
  "Orca V2",          // pre-Whirlpool AMM
  "Lifinity",
  "Saber",
  "Saber (Decimals)",
  "Cropper",
  "Aldrin V2",
  "Mercurial",
  "FluxBeam",
  "Bonkswap",
  "Token Swap",
].join(",");

/**
 * The dex ladder: safest flat-CPI set → wider (covers memecoins that only
 * trade on Meteora/Orca CLMM) → Phoenix-only (narrowest, always flat).
 *
 * On a CPI-depth failure we step to the next entry; the final Phoenix-only
 * fallback is guaranteed flat. On a no-routes failure the wider second entry
 * rescues tokens with no flat-CPI pool. Order: safe → wide → narrowest.
 *
 * DEX_FILTER env override replaces the first entry:
 *   unset      → FLAT_CPI_DEXES (safe default)
 *   ""         → empty filter, Jupiter picks any route incl. nested DEXes
 *   "<labels>" → custom comma-separated Jupiter dex labels
 */
export function dexLadder(): string[] {
  const override = process.env.DEX_FILTER;
  const first = override !== undefined ? override : FLAT_CPI_DEXES;
  return [
    first,
    "Phoenix,Raydium,Meteora,Orca", // wider — covers most memecoins
    "Phoenix",                       // narrowest, always flat
  ];
}

export function buildDefaultLadder(): number[] {
  const ceiling = Number(process.env.JUP_MAX_ACCOUNTS ?? 32);
  return Array.from(new Set([ceiling, 28, 24, 20])).filter((v) => v >= 16);
}

/**
 * Exported for tests — classifies the relayer error so callers can drive the
 * same ladder in non-swap contexts.
 *
 *   cpi-or-no-routes → switch DEX set (different venue). Checked FIRST so a
 *                      502 that wraps "call depth too deep" is NOT mistaken
 *                      for a transient route-stale 502.
 *   tx-too-large     → drop maxAccounts, same DEX set.
 *   route-stale      → retry in place once (transient).
 *   fatal            → bubble up.
 */
export type SwapErrKind = "cpi-or-no-routes" | "tx-too-large" | "route-stale" | "fatal";

export function classifySwapErr(message: string): SwapErrKind {
  // CPI depth / no-routes FIRST — these arrive wrapped in a 502 rpc_failure,
  // so they must be matched before the generic 502 route-stale rule below.
  if (
    message.includes("call depth too deep") ||
    message.includes("CallDepth") ||
    message.includes("No routes") ||
    message.includes("NO_ROUTES_FOUND") ||
    message.includes("no Jupiter route")
  ) return "cpi-or-no-routes";
  if (
    message.includes("encoding overruns Uint8Array") ||
    message.includes("tx_too_large") ||
    message.includes("serialised tx")
  ) return "tx-too-large";
  if (
    message.includes("0x1789") ||
    /\b0x9\b/.test(message) ||
    (message.includes("502") && message.includes("rpc_failure"))
  ) return "route-stale";
  return "fatal";
}

export async function swapWithLadder(
  sdk: SwapLike,
  args: LadderOptions,
): Promise<{ signature?: string; sig?: string; outAmount?: bigint | string }> {
  const maxAccLadder = args.ladder ?? buildDefaultLadder();
  const dexes = args.dexLadderOverride ?? dexLadder();
  let lastErr: unknown = null;

  // Outer: dex set (fixes CPI-depth / no-routes). Inner: maxAccounts (fixes
  // tx-too-large). Mirrors the reference trader's executePrivateSwap exactly.
  outer: for (const dexSet of dexes) {
    for (let i = 0; i < maxAccLadder.length; i++) {
      const maxAccounts = maxAccLadder[i]!;
      const isLastMaxAcc = i === maxAccLadder.length - 1;
      try {
        return await sdk.swap({
          inMint: args.inMint,
          outMint: args.outMint,
          amount: args.amount,
          slippageBps: args.slippageBps ?? 50,
          maxAccounts,
          dexes: dexSet,
        });
      } catch (e) {
        lastErr = e;
        const kind = classifySwapErr((e as Error).message ?? "");

        // CPI depth / no-routes: this DEX set can't serve the trade. Drop to
        // the next (narrower / wider) set; maxAccounts won't help.
        if (kind === "cpi-or-no-routes") continue outer;

        // tx-too-large: route fits a venue but the wrapped tx overflows.
        // Shrink maxAccounts, same DEX set.
        if (kind === "tx-too-large" && !isLastMaxAcc) continue;

        // Transient route-stale: retry once in place (same dexes, maxAccounts).
        if (kind === "route-stale") {
          try {
            return await sdk.swap({
              inMint: args.inMint,
              outMint: args.outMint,
              amount: args.amount,
              slippageBps: args.slippageBps ?? 50,
              maxAccounts,
              dexes: dexSet,
            });
          } catch (e2) {
            lastErr = e2;
            // Re-classify the retry failure: a route-stale that turns into a
            // CPI/no-routes on retry should still walk the dex ladder.
            if (classifySwapErr((e2 as Error).message ?? "") === "cpi-or-no-routes") continue outer;
          }
        }

        // tx-too-large at the last maxAccounts, or any fatal error: bubble up.
        throw e;
      }
    }
  }
  throw lastErr ?? new Error("swap failed at all dex sets and maxAccounts");
}
