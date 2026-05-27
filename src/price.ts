/**
 * SOL/USD price source — display-only.
 *
 * All on-chain math uses lamports. This module exists to print "$X" next
 * to user balances in the Telegram UI; nothing depends on price accuracy
 * for safety. Cached 60s, with a 5-min backoff on failure to avoid
 * hammering Coingecko's free tier into a 429-loop.
 *
 * No config fallback (the reference trader had `config.solUsd` as a hardcoded
 * default — feedback rule says never hardcode token prices in product
 * code). On every failure path, callers receive `null` and the renderer
 * omits the USD line.
 */
import { log } from "./log.js";

let cachedUsd: number | null = null;
let cachedAt = 0;
const TTL_MS = 60_000;
const FAILURE_TTL_MS = 5 * 60_000;
let failureBackoffUntil = 0;

/**
 * Returns the cached SOL/USD price, or null if the cache is empty and
 * the upstream fetch failed. Callers MUST handle null by omitting the
 * USD line — they should not substitute a hardcoded fallback.
 */
export async function getSolUsd(): Promise<number | null> {
  const now = Date.now();
  if (cachedUsd !== null && now - cachedAt < TTL_MS) return cachedUsd;
  if (now < failureBackoffUntil) return cachedUsd; // serve last-known or null

  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) },
    );
    const d = (await r.json()) as { solana?: { usd?: number } };
    const usd = d?.solana?.usd;
    if (typeof usd === "number" && usd > 0) {
      cachedUsd = usd;
      cachedAt = now;
      return usd;
    }
    throw new Error(`bad price payload: ${JSON.stringify(d).slice(0, 150)}`);
  } catch (e) {
    failureBackoffUntil = now + FAILURE_TTL_MS;
    log.warn({ err: (e as Error)?.message, backoffMin: 5 }, "SOL price fetch failed");
    return cachedUsd; // null if we never had a value
  }
}

/** Format a SOL amount as USD using a known price. Caller checks for null. */
export function solUsd(solAmount: number, usdPerSol: number): string {
  return `$${(solAmount * usdPerSol).toFixed(2)}`;
}

/** Test seam — reset module-level caches between tests. */
export function _resetPriceCacheForTests(): void {
  cachedUsd = null;
  cachedAt = 0;
  failureBackoffUntil = 0;
}
