/**
 * Leader stats — answer "is this wallet worth following?"
 *
 *   1. Fetch enhanced txs from Helius for the wallet (last 100, ≤7d window).
 *   2. Classify each as buy / sell / other (preferring events.swap, falling
 *      back to nativeTransfers + tokenTransfers for pump.fun-style txs).
 *   3. FIFO-match buys → sells per mint to compute closed-position PnL.
 *   4. Aggregate: counts, win rate, hold time, hourly histogram, top mints.
 *
 * Caveats called out by callers (panel renderers):
 *   - Open positions aren't valued in v1.
 *   - "Win rate" = closed positions only.
 *   - Hold time = first buy → first matching sell.
 *
 * Pure data layer — no Telegram rendering. The /leader panel imports
 * `computeStats` + `getLeaderStats` and decides the wire format.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const HELIUS_BASE = "https://api.helius.xyz/v0/addresses";
const DEFAULT_LOOKBACK_SECS = 7 * 24 * 60 * 60;
// Helius caps per-call at 100. For 7-day stats this is enough for ~90% of
// wallets — anything past it within 7d is usually a MEV bot rather than a
// leader worth following, so degraded coverage is acceptable.
const DEFAULT_LIMIT = 100;

export interface HeliusSwapEvent {
  nativeInput?: { account: string; amount: string };
  nativeOutput?: { account: string; amount: string };
  tokenInputs?: Array<{ userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }>;
  tokenOutputs?: Array<{ userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }>;
}

export interface HeliusEnhancedTx {
  signature: string;
  slot: number;
  timestamp?: number;
  feePayer: string;
  type?: string;
  events?: { swap?: HeliusSwapEvent };
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number | string;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    tokenAmount: number;
    mint: string;
    rawTokenAmount?: { tokenAmount: string; decimals: number };
  }>;
}

export interface LeaderAction {
  kind: "buy" | "sell" | "other";
  mint: string;
  solLamports: bigint;
  rawTokens: bigint;
  decimals: number;
  timestamp: number;
  signature: string;
}

export interface ClosedPosition {
  mint: string;
  buyTs: number;
  sellTs: number;
  buySolLamports: bigint;
  sellSolLamports: bigint;
  pnlLamports: bigint;
  holdSecs: number;
}

export interface LeaderStats {
  wallet: string;
  lookbackSecs: number;
  buys: number;
  sells: number;
  closed: ClosedPosition[];
  wins: number;
  losses: number;
  // null = no closed positions (avoid divide-by-zero)
  winRatePct: number | null;
  netClosedSolLamports: bigint;
  totalBuyVolumeLamports: bigint;
  bestTrade: ClosedPosition | null;
  worstTrade: ClosedPosition | null;
  avgHoldSecs: number | null;
  // 24-element UTC hourly histogram of buy timestamps
  hoursHistogram: number[];
  topMints: Array<{ mint: string; volumeLamports: bigint; buys: number }>;
}

export async function fetchWalletHistory(
  wallet: string,
  apiKey: string,
  limit = DEFAULT_LIMIT,
): Promise<HeliusEnhancedTx[]> {
  const url = `${HELIUS_BASE}/${wallet}/transactions?api-key=${apiKey}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`helius wallet history ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as HeliusEnhancedTx[];
  return Array.isArray(data) ? data : [];
}

/**
 * Classify one Helius enhanced tx as a buy/sell/other from the wallet's
 * perspective. events.swap is preferred (Jupiter / Raydium / Meteora /
 * Phoenix); the transfer-array fallback covers pump.fun and any DEX
 * Helius hasn't normalized.
 */
export function parseAction(tx: HeliusEnhancedTx, wallet: string): LeaderAction {
  const sig = tx.signature;
  const ts = typeof tx.timestamp === "number" ? tx.timestamp : 0;
  const none: LeaderAction = {
    kind: "other", mint: "", solLamports: 0n, rawTokens: 0n,
    decimals: 0, timestamp: ts, signature: sig,
  };
  if (tx.feePayer !== wallet) return none;

  const sw = tx.events?.swap;
  if (sw) {
    const nIn = sw.nativeInput;
    if (nIn && nIn.account === wallet && nIn.amount && nIn.amount !== "0") {
      const outs = (sw.tokenOutputs ?? []).filter(
        (o) => o.userAccount === wallet && o.mint !== WSOL_MINT,
      );
      if (outs.length > 0) {
        const chosen = outs.reduce((m, c) =>
          BigInt(c.rawTokenAmount.tokenAmount) > BigInt(m.rawTokenAmount.tokenAmount) ? c : m,
        );
        return {
          kind: "buy", mint: chosen.mint,
          solLamports: BigInt(nIn.amount),
          rawTokens: BigInt(chosen.rawTokenAmount.tokenAmount),
          decimals: chosen.rawTokenAmount.decimals,
          timestamp: ts, signature: sig,
        };
      }
    }
    const nOut = sw.nativeOutput;
    if (nOut && nOut.account === wallet && nOut.amount && nOut.amount !== "0") {
      const ins = (sw.tokenInputs ?? []).filter(
        (i) => i.userAccount === wallet && i.mint !== WSOL_MINT,
      );
      if (ins.length > 0) {
        const chosen = ins.reduce((m, c) =>
          BigInt(c.rawTokenAmount.tokenAmount) > BigInt(m.rawTokenAmount.tokenAmount) ? c : m,
        );
        return {
          kind: "sell", mint: chosen.mint,
          solLamports: BigInt(nOut.amount),
          rawTokens: BigInt(chosen.rawTokenAmount.tokenAmount),
          decimals: chosen.rawTokenAmount.decimals,
          timestamp: ts, signature: sig,
        };
      }
    }
  }

  if (tx.type !== "SWAP") return none;
  return parseActionFromTransfers(tx, wallet, sig, ts);
}

// Helius tokenTransfers expose pre-divided human-units floats. Scaling
// by 1e9 keeps 9 decimals of precision through FIFO matching — consistent
// scaling across the buy/sell pair of the same mint is what matters, not
// matching the on-chain decimals exactly.
const FALLBACK_TOKEN_SCALE = 1_000_000_000;

function parseActionFromTransfers(
  tx: HeliusEnhancedTx,
  wallet: string,
  sig: string,
  ts: number,
): LeaderAction {
  const none: LeaderAction = {
    kind: "other", mint: "", solLamports: 0n, rawTokens: 0n,
    decimals: 0, timestamp: ts, signature: sig,
  };

  const nats = tx.nativeTransfers ?? [];
  let netSolOut = 0n;
  for (const n of nats) {
    const amt = BigInt(n.amount);
    if (n.fromUserAccount === wallet) netSolOut += amt;
    if (n.toUserAccount === wallet) netSolOut -= amt;
  }
  const toks = tx.tokenTransfers ?? [];

  if (netSolOut > 0n) {
    const credited = toks.filter(
      (t) => t.toUserAccount === wallet && t.mint !== WSOL_MINT,
    );
    if (credited.length === 0) return none;
    const chosen = credited.reduce((m, c) =>
      Number(c.tokenAmount) > Number(m.tokenAmount) ? c : m,
    );
    return {
      kind: "buy",
      mint: chosen.mint,
      solLamports: netSolOut,
      rawTokens: chosen.rawTokenAmount
        ? BigInt(chosen.rawTokenAmount.tokenAmount)
        : BigInt(Math.floor(Number(chosen.tokenAmount) * FALLBACK_TOKEN_SCALE)),
      decimals: chosen.rawTokenAmount?.decimals ?? 9,
      timestamp: ts, signature: sig,
    };
  }
  if (netSolOut < 0n) {
    const debited = toks.filter(
      (t) => t.fromUserAccount === wallet && t.mint !== WSOL_MINT,
    );
    if (debited.length === 0) return none;
    const chosen = debited.reduce((m, c) =>
      Number(c.tokenAmount) > Number(m.tokenAmount) ? c : m,
    );
    return {
      kind: "sell",
      mint: chosen.mint,
      solLamports: -netSolOut,
      rawTokens: chosen.rawTokenAmount
        ? BigInt(chosen.rawTokenAmount.tokenAmount)
        : BigInt(Math.floor(Number(chosen.tokenAmount) * FALLBACK_TOKEN_SCALE)),
      decimals: chosen.rawTokenAmount?.decimals ?? 9,
      timestamp: ts, signature: sig,
    };
  }
  return none;
}

/**
 * FIFO-match buys and sells per mint, pro-rating partial closes by the
 * fraction of the open lot consumed. Pure function — easy to unit test.
 */
export function computeStats(
  wallet: string,
  actions: LeaderAction[],
  lookbackSecs: number,
): LeaderStats {
  const sorted = [...actions].sort((a, b) => a.timestamp - b.timestamp);

  const buys = sorted.filter((a) => a.kind === "buy");
  const sells = sorted.filter((a) => a.kind === "sell");

  const openLots = new Map<string, Array<{ remainingTokens: bigint; solCostLamports: bigint; ts: number }>>();
  const closed: ClosedPosition[] = [];

  for (const a of sorted) {
    if (a.kind === "buy") {
      const lots = openLots.get(a.mint) ?? [];
      lots.push({ remainingTokens: a.rawTokens, solCostLamports: a.solLamports, ts: a.timestamp });
      openLots.set(a.mint, lots);
    } else if (a.kind === "sell") {
      let remainingToSell = a.rawTokens;
      let solReceivedRemaining = a.solLamports;
      const lots = openLots.get(a.mint) ?? [];
      while (remainingToSell > 0n && lots.length > 0) {
        const lot = lots[0]!;
        const matched = remainingToSell < lot.remainingTokens ? remainingToSell : lot.remainingTokens;
        const buyCostPortion = (lot.solCostLamports * matched) / lot.remainingTokens;
        const sellProceedsPortion =
          remainingToSell > 0n ? (solReceivedRemaining * matched) / remainingToSell : 0n;
        closed.push({
          mint: a.mint,
          buyTs: lot.ts,
          sellTs: a.timestamp,
          buySolLamports: buyCostPortion,
          sellSolLamports: sellProceedsPortion,
          pnlLamports: sellProceedsPortion - buyCostPortion,
          holdSecs: a.timestamp - lot.ts,
        });
        lot.remainingTokens -= matched;
        lot.solCostLamports -= buyCostPortion;
        remainingToSell -= matched;
        solReceivedRemaining -= sellProceedsPortion;
        if (lot.remainingTokens === 0n) lots.shift();
      }
      // remainingToSell > 0 here = sold more than we have on file → buy
      // landed before the window or DEX-funded balance. Drop silently.
    }
  }

  const wins = closed.filter((c) => c.pnlLamports > 0n).length;
  const losses = closed.filter((c) => c.pnlLamports < 0n).length;
  const decided = wins + losses;
  const winRatePct = decided > 0 ? Math.round((wins / decided) * 100) : null;

  const netClosedSolLamports = closed.reduce((s, c) => s + c.pnlLamports, 0n);
  const totalBuyVolumeLamports = buys.reduce((s, b) => s + b.solLamports, 0n);

  const bestTrade = closed.length
    ? closed.reduce((m, c) => (c.pnlLamports > m.pnlLamports ? c : m))
    : null;
  const worstTrade = closed.length
    ? closed.reduce((m, c) => (c.pnlLamports < m.pnlLamports ? c : m))
    : null;
  const avgHoldSecs = closed.length
    ? Math.round(closed.reduce((s, c) => s + c.holdSecs, 0) / closed.length)
    : null;

  const hoursHistogram = new Array<number>(24).fill(0);
  for (const b of buys) {
    if (b.timestamp > 0) {
      const h = new Date(b.timestamp * 1000).getUTCHours();
      hoursHistogram[h] = (hoursHistogram[h] ?? 0) + 1;
    }
  }

  const mintVolume = new Map<string, { volume: bigint; count: number }>();
  for (const b of buys) {
    const cur = mintVolume.get(b.mint) ?? { volume: 0n, count: 0 };
    cur.volume += b.solLamports;
    cur.count += 1;
    mintVolume.set(b.mint, cur);
  }
  const topMints = Array.from(mintVolume.entries())
    .map(([mint, v]) => ({ mint, volumeLamports: v.volume, buys: v.count }))
    .sort((a, b) => (b.volumeLamports > a.volumeLamports ? 1 : b.volumeLamports < a.volumeLamports ? -1 : 0))
    .slice(0, 3);

  return {
    wallet,
    lookbackSecs,
    buys: buys.length,
    sells: sells.length,
    closed,
    wins,
    losses,
    winRatePct,
    netClosedSolLamports,
    totalBuyVolumeLamports,
    bestTrade,
    worstTrade,
    avgHoldSecs,
    hoursHistogram,
    topMints,
  };
}

/** fetch + classify + aggregate, filtered to lookback window. */
export async function getLeaderStats(
  wallet: string,
  apiKey: string,
  lookbackSecs = DEFAULT_LOOKBACK_SECS,
  limit = DEFAULT_LIMIT,
): Promise<LeaderStats> {
  const txs = await fetchWalletHistory(wallet, apiKey, limit);
  const cutoff = Math.floor(Date.now() / 1000) - lookbackSecs;
  const filtered = txs.filter((t) => typeof t.timestamp === "number" && t.timestamp >= cutoff);
  const actions = filtered.map((t) => parseAction(t, wallet)).filter((a) => a.kind !== "other");
  return computeStats(wallet, actions, lookbackSecs);
}
