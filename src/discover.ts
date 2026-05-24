/**
 * Leader discovery — score candidate wallets by recent on-chain
 * performance, so an agent can pick which to /follow.
 *
 * Heuristic (intentionally simple; no ML):
 *   For each candidate's recent SWAP txs in the lookback window:
 *     buys           = count of SOL → token swaps
 *     pnl_sol_rough  = sum(token-out swap proceeds) - sum(SOL spent on buys)
 *   score = log(buys + 1) * sign(pnl) * sqrt(|pnl|)
 *
 * `score` favors wallets that both ACT (high buy count) AND realize
 *  positive PnL on a meaningful magnitude. log + sqrt damp outliers.
 *
 * The actual Helius fetch lives behind a `fetchHistory` dependency
 * so the scoring is unit-testable and the network path is its own
 * concern.
 */
import { parseSwap } from "./copy-trade/parse-swap.js";
import type { HeliusEnhancedTx } from "./copy-trade/types.js";

export interface DiscoverArgs {
  candidates: string[];
  lookbackHours: number;
}

export interface LeaderScore {
  wallet: string;
  score: number;
  buys: number;
  pnlSol: number;
}

export interface DiscoverDeps {
  fetchHistory(wallet: string, sinceUnixSec: number): Promise<HeliusEnhancedTx[]>;
  /** Optional clock injection for tests. */
  now?: () => number;
}

export function makeDiscover(deps: DiscoverDeps) {
  return async function discover(args: DiscoverArgs): Promise<LeaderScore[]> {
    const now = (deps.now ?? Date.now)() / 1000;
    const sinceSec = now - args.lookbackHours * 3600;

    return Promise.all(
      args.candidates.map(async (wallet): Promise<LeaderScore> => {
        let buys = 0;
        let solSpentLamports = 0n;
        let solReceivedLamports = 0n;

        const txs = await deps.fetchHistory(wallet, sinceSec).catch(() => [] as HeliusEnhancedTx[]);
        for (const tx of txs) {
          const swap = parseSwap(tx, wallet);
          if (swap) {
            buys += 1;
            solSpentLamports += swap.amountIn;
            continue;
          }
          // Sell-side: net SOL credited to the wallet on a token-out tx.
          const sellSol = sellSolReceived(tx, wallet);
          if (sellSol > 0n) solReceivedLamports += sellSol;
        }

        const pnlSol = Number(solReceivedLamports - solSpentLamports) / 1e9;
        const score = scoreFromCounts(buys, pnlSol);
        return { wallet, score, buys, pnlSol };
      }),
    );
  };
}

function sellSolReceived(tx: HeliusEnhancedTx, wallet: string): bigint {
  if (tx.feePayer !== wallet) return 0n;
  let netIn = 0n;
  for (const t of tx.nativeTransfers ?? []) {
    if (t.toUserAccount === wallet) netIn += BigInt(t.amount);
    if (t.fromUserAccount === wallet) netIn -= BigInt(t.amount);
  }
  for (const t of tx.tokenTransfers ?? []) {
    if (t.mint !== "So11111111111111111111111111111111111111112" || !t.rawTokenAmount) continue;
    if (t.toUserAccount === wallet) netIn += BigInt(t.rawTokenAmount.tokenAmount);
    if (t.fromUserAccount === wallet) netIn -= BigInt(t.rawTokenAmount.tokenAmount);
  }
  return netIn > 0n ? netIn : 0n;
}

export function scoreFromCounts(buys: number, pnlSol: number): number {
  if (buys === 0 && pnlSol === 0) return 0;
  const activity = Math.log(buys + 1);
  const sign = pnlSol >= 0 ? 1 : -1;
  return activity * sign * Math.sqrt(Math.abs(pnlSol));
}
