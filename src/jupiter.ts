/**
 * Jupiter swap API client — quotes + token metadata only.
 *
 * stealth-trader doesn't execute swaps through the public Jupiter API
 * directly; the b402 relayer wraps Jupiter under privacy. This module
 * exists for preview/UX:
 *
 *   - getQuote(in, out, amount, slip)   — price + outAmount estimate
 *   - getTokenInfo(mint)                — symbol/name/decimals
 *   - getTokenDecimals(mint)            — exact decimals via RPC
 *   - getTokenSupply(mint)              — for marketcap UX
 *   - valueTokensInSol(mint, raw)       — NAV for a token holding
 *
 * Rate limits: api.jup.ag charges per IP. JUPITER_API_KEY (or JUP_API_KEY)
 * raises the cap. quoteCache (20s) and navCache (15s) keep the Buy/Sell
 * panel under the free-tier limit during normal interactive use.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { log } from "./log.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

const JUP_BASE = process.env.JUPITER_API_BASE ?? "https://api.jup.ag/swap/v1";
const JUP_KEY = process.env.JUP_API_KEY ?? process.env.JUPITER_API_KEY;

export interface Quote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  inputMint: string;
  outputMint: string;
  // Jupiter's full quote object — opaque, passed to the swap call.
  raw: Record<string, unknown>;
}

async function jupFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const url = `${JUP_BASE}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (JUP_KEY) headers["x-api-key"] = JUP_KEY;
  // 3 attempts, exponential 1s/2s backoff on 429. Jupiter Lite caps ~5 RPS
  // per IP; a single transient burst usually clears in one backoff.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { ...init, headers });
    if (r.ok) return (await r.json()) as Record<string, unknown>;
    if (r.status === 429 && attempt < 2) {
      const delayMs = 1000 * (attempt + 1);
      log.warn({ url, attempt }, `Jupiter 429 backing off ${delayMs}ms`);
      await new Promise((res) => setTimeout(res, delayMs));
      continue;
    }
    const body = await r.text().catch(() => "");
    throw new Error(`Jupiter ${r.status} ${r.statusText}: ${body.slice(0, 200)}`);
  }
  throw new Error("unreachable");
}

const quoteCache = new Map<string, { q: Quote; ts: number }>();
const QUOTE_CACHE_MS = 20_000;

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  slippageBps = 300,
): Promise<Quote> {
  const key = `${inputMint}:${outputMint}:${amount}:${slippageBps}`;
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.ts < QUOTE_CACHE_MS) return cached.q;

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: "false",
    asLegacyTransaction: "false",
  });
  const q = await jupFetch(`/quote?${params}`);
  if (!q || !q.outAmount) throw new Error("Jupiter returned no quote");
  const quote: Quote = {
    inAmount: q.inAmount as string,
    outAmount: q.outAmount as string,
    otherAmountThreshold: q.otherAmountThreshold as string,
    priceImpactPct: q.priceImpactPct as string,
    inputMint: q.inputMint as string,
    outputMint: q.outputMint as string,
    raw: q,
  };
  quoteCache.set(key, { q: quote, ts: Date.now() });
  return quote;
}

// Circuit breaker: when Jupiter rate-limits us, pause ALL quote attempts
// for 30s. Cheaper to skip a NAV poll than hammer and extend the throttle.
const navCache = new Map<string, { value: bigint; ts: number }>();
const NAV_CACHE_MS = 15_000;
let quoteBlockedUntil = 0;

/**
 * Sell-side quote: how much SOL does `tokensAmount` of `tokenMint` cash out to?
 * Returns lamports of wSOL. Used by holdings views for NAV / PnL display.
 * Single attempt — no retry; if Jupiter throws, the caller skips this poll.
 */
export async function valueTokensInSol(tokenMint: string, tokensAmount: bigint): Promise<bigint> {
  if (tokensAmount === 0n) return 0n;
  const cacheKey = `${tokenMint}:${tokensAmount}`;
  const cached = navCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NAV_CACHE_MS) return cached.value;

  if (Date.now() < quoteBlockedUntil) {
    throw new Error(`quote circuit breaker open until ${new Date(quoteBlockedUntil).toISOString()}`);
  }

  try {
    const q = await getQuote(tokenMint, SOL_MINT, tokensAmount, 500);
    const out = BigInt(q.outAmount);
    if (out === 0n) throw new Error(`Jupiter returned 0 outAmount for ${tokenMint} (no route)`);
    navCache.set(cacheKey, { value: out, ts: Date.now() });
    return out;
  } catch (e) {
    const msg = (e as Error)?.message ?? "";
    if (msg.includes("429")) {
      quoteBlockedUntil = Date.now() + 30_000;
      log.warn({ until: new Date(quoteBlockedUntil).toISOString() }, "Jupiter 429 circuit breaker 30s");
    }
    throw e;
  }
}

// SPL mint decimals are immutable on chain — cache forever once read.
const decimalsCache = new Map<string, number>();

export async function getTokenDecimals(connection: Connection, mint: string): Promise<number> {
  const cached = decimalsCache.get(mint);
  if (cached !== undefined) return cached;
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  // getParsedAccountInfo returns the raw RPC envelope; parsed.info.decimals
  // is the canonical location for SPL Token + Token-2022 mints.
  const data = info.value?.data as
    | { parsed?: { info?: { decimals?: number } } }
    | undefined;
  if (data?.parsed?.info?.decimals !== undefined) {
    const d = Number(data.parsed.info.decimals);
    decimalsCache.set(mint, d);
    return d;
  }
  throw new Error(`Could not fetch decimals for ${mint}`);
}

// Supply can change (burns/mints) — bound the cache so we surface fresh
// numbers within a few minutes of a notable on-chain change.
const tokenSupplyCache = new Map<string, { supplyHuman: number; decimals: number; ts: number }>();
const SUPPLY_CACHE_MS = 5 * 60_000;

export async function getTokenSupply(
  connection: Connection,
  mint: string,
): Promise<{ supplyHuman: number; decimals: number }> {
  const cached = tokenSupplyCache.get(mint);
  if (cached && Date.now() - cached.ts < SUPPLY_CACHE_MS) {
    return { supplyHuman: cached.supplyHuman, decimals: cached.decimals };
  }
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const data = info.value?.data as
    | { parsed?: { info?: { supply?: string; decimals?: number } } }
    | undefined;
  const supply = data?.parsed?.info?.supply;
  const decimals = data?.parsed?.info?.decimals;
  if (supply === undefined || decimals === undefined) {
    throw new Error(`Could not fetch supply for ${mint}`);
  }
  const supplyHuman = Number(BigInt(supply)) / 10 ** Number(decimals);
  if (!Number.isFinite(supplyHuman) || supplyHuman <= 0) {
    throw new Error(`Invalid supply for ${mint}: ${supply}`);
  }
  tokenSupplyCache.set(mint, { supplyHuman, decimals: Number(decimals), ts: Date.now() });
  return { supplyHuman, decimals: Number(decimals) };
}

export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
}

const tokenInfoCache = new Map<string, TokenInfo>();

async function fetchFromJupiter(mint: string): Promise<TokenInfo | null> {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { symbol?: string; name?: string; decimals?: number };
    if (!d || typeof d.decimals !== "number") return null;
    return {
      symbol: d.symbol ?? mint.slice(0, 4),
      name: d.name ?? "Unknown",
      decimals: d.decimals,
    };
  } catch {
    return null;
  }
}

async function fetchFromDexScreener(mint: string): Promise<TokenInfo | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const arr = (await r.json()) as Array<{ baseToken?: { symbol?: string; name?: string } }>;
    const item = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
    if (!item) return null;
    const symbol = item.baseToken?.symbol;
    const name = item.baseToken?.name;
    if (!symbol) return null;
    // DexScreener's public API doesn't return decimals. 6 is the Pump.fun
    // default; for non-Pump tokens that miss Jupiter's index, callers must
    // fall back to getTokenDecimals (chain query) for math-critical paths.
    return { symbol, name: name ?? symbol, decimals: 6 };
  } catch {
    return null;
  }
}

/**
 * Jupiter first (reliable + has decimals), DexScreener second (covers
 * fresh Pump.fun graduates Jupiter hasn't indexed). Cached in-process.
 */
export async function getTokenInfo(mint: string): Promise<TokenInfo | null> {
  const cached = tokenInfoCache.get(mint);
  if (cached) return cached;
  const info = (await fetchFromJupiter(mint)) ?? (await fetchFromDexScreener(mint));
  if (info) tokenInfoCache.set(mint, info);
  return info;
}
