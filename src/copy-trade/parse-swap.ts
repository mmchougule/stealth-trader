/**
 * Helius enhanced-tx → ParsedSwap | null.
 *
 * Contract: returns non-null only for a SOL → token buy by `watchedWallet`.
 *
 * We do NOT trust `tx.events.swap` — Helius's enrichment underreports
 * `nativeInput.amount` on Jupiter-routed-to-pump.fun trades (it reports
 * the priority-fee leg, not the main wSOL leg). The transfer arrays
 * (`nativeTransfers` + `tokenTransfers`) are ground truth; we sum them
 * to derive amounts.
 *
 * Buy heuristic, scoped to the watched wallet:
 *   - Net SOL out of wallet > 0  (the swap input, dominates dust + fees)
 *   - At least one non-wSOL token transferred IN to the wallet
 *   - tokenOut = the largest non-wSOL token credited to the wallet
 */
import type { HeliusEnhancedTx, ParsedSwap } from "./types.js";
import { WSOL_MINT } from "./types.js";

export function parseSwap(
  tx: HeliusEnhancedTx,
  watchedWallet: string,
): ParsedSwap | null {
  if (tx.feePayer !== watchedWallet) return null;

  const nats = tx.nativeTransfers ?? [];
  let netSolOut = 0n;
  for (const n of nats) {
    const amt = BigInt(n.amount);
    if (n.fromUserAccount === watchedWallet) netSolOut += amt;
    if (n.toUserAccount === watchedWallet) netSolOut -= amt;
  }

  // Add wSOL transfer legs — Jupiter routes can send the main swap input
  // as a wSOL SPL transfer rather than a native SOL transfer. Without this,
  // wSOL-only swaps would report netSolOut=0 and be classified as non-buys.
  const toks = tx.tokenTransfers ?? [];
  for (const t of toks) {
    if (t.mint !== WSOL_MINT) continue;
    if (!t.rawTokenAmount) continue;
    const amt = BigInt(t.rawTokenAmount.tokenAmount);
    if (t.fromUserAccount === watchedWallet) netSolOut += amt;
    if (t.toUserAccount === watchedWallet) netSolOut -= amt;
  }

  if (netSolOut <= 0n) return null;

  const credited = toks.filter(
    (t) => t.toUserAccount === watchedWallet && t.mint !== WSOL_MINT,
  );
  if (credited.length === 0) return null;

  // Pick the largest credited (by tokenAmount float; raw not always present).
  const chosen = credited.reduce((max, cur) =>
    Number(cur.tokenAmount) > Number(max.tokenAmount) ? cur : max,
  );

  const rawTokens = chosen.rawTokenAmount
    ? BigInt(chosen.rawTokenAmount.tokenAmount)
    : 0n;
  const decimals = chosen.rawTokenAmount?.decimals ?? 0;

  return {
    wallet: watchedWallet,
    tokenIn: WSOL_MINT,
    tokenOut: chosen.mint,
    amountIn: netSolOut,
    leaderTokensOut: rawTokens,
    leaderTokenDecimals: decimals,
    signature: tx.signature,
    slot: tx.slot,
    timestamp: typeof tx.timestamp === "number" ? tx.timestamp : null,
  };
}

/** Parse a batch of Helius txs scoped to one watched wallet. */
export function parseBatch(
  txs: HeliusEnhancedTx[],
  watchedWallet: string,
): ParsedSwap[] {
  const out: ParsedSwap[] = [];
  for (const tx of txs) {
    const s = parseSwap(tx, watchedWallet);
    if (s !== null) out.push(s);
  }
  return out;
}
