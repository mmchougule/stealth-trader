/**
 * Swap retry ladder. The b402 relayer rejects oversized Jupiter routes
 * with one of:
 *   - "encoding overruns Uint8Array"
 *   - "tx_too_large"
 *   - "serialised tx"
 * These are all symptoms of the wrapped v0 tx exceeding Solana's 1232 B
 * packet cap. Dropping maxAccounts shrinks the Jupiter route footprint
 * until it fits.
 *
 * Transient route-staleness (0x9 SlippageToleranceExceeded, 0x1789
 * RouteStale, 502 rpc_failure) gets a single in-place retry at the same
 * maxAccounts — Jupiter routes refresh in <1s.
 *
 * Other error classes (real on-chain failures, relayer 4xx, etc.) bubble
 * up unchanged so the caller's error handler can decide policy.
 */
import type { PublicKey } from "@solana/web3.js";

export interface SwapLike {
  swap(opts: {
    inMint: PublicKey;
    outMint: PublicKey;
    amount: bigint;
    maxAccounts?: number;
    slippageBps?: number;
  }): Promise<{ signature?: string; sig?: string; outAmount?: bigint | string }>;
}

export interface LadderOptions {
  inMint: PublicKey;
  outMint: PublicKey;
  amount: bigint;
  slippageBps?: number;
  /** Override the maxAccounts ladder. Falls back to env JUP_MAX_ACCOUNTS / [32,28,24,20]. */
  ladder?: number[];
}

export function buildDefaultLadder(): number[] {
  const ceiling = Number(process.env.JUP_MAX_ACCOUNTS ?? 32);
  return Array.from(new Set([ceiling, 28, 24, 20])).filter((v) => v >= 16);
}

/**
 * Exported for tests — classifies the relayer error so callers can drive
 * the same ladder in non-swap contexts (e.g. shield-and-swap rollback).
 */
export type SwapErrKind = "tx-too-large" | "route-stale" | "fatal";

export function classifySwapErr(message: string): SwapErrKind {
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
  const ladder = args.ladder ?? buildDefaultLadder();
  let lastErr: unknown = null;
  for (let i = 0; i < ladder.length; i++) {
    const maxAccounts = ladder[i]!;
    const isLast = i === ladder.length - 1;
    try {
      return await sdk.swap({
        inMint: args.inMint,
        outMint: args.outMint,
        amount: args.amount,
        slippageBps: args.slippageBps ?? 50,
        maxAccounts,
      });
    } catch (e) {
      lastErr = e;
      const kind = classifySwapErr((e as Error).message ?? "");
      if (kind === "tx-too-large" && !isLast) continue;
      if (kind === "route-stale") {
        try {
          return await sdk.swap({
            inMint: args.inMint,
            outMint: args.outMint,
            amount: args.amount,
            slippageBps: args.slippageBps ?? 50,
            maxAccounts,
          });
        } catch (e2) {
          lastErr = e2;
        }
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("swap failed at all maxAccounts");
}
