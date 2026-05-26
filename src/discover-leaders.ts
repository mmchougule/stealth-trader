/**
 * Curated leaders to bootstrap new users.
 *
 * Picked from b402-trader's find-leader-candidates run (2026-05-22) against
 * Jupiter v6 + pump.fun + Raydium AMM v4 + Raydium CLMM + Meteora DLMM.
 * Filter: 4+ buys in 7d, win rate >= 50% on closed positions, net P&L > 0,
 * buy volume <= 50 SOL, PnL/volume <= 5x (MEV/sandwich sanity guard).
 *
 * Not endorsements — starting points. /leader <wallet> renders fresh stats
 * the first time a user taps into one, so they see current performance
 * before committing.
 *
 * Refresh: the candidate-finder script lives in b402-trader (local-only);
 * the picks are committed here. Re-run weekly to keep blurbs honest.
 */
export interface RecommendedLeader {
  wallet: string;
  label: string;
  blurb: string;
}

export const RECOMMENDED_LEADERS: RecommendedLeader[] = [
  {
    wallet: "9BkpVwAmVMEsqxtQcBbdPtUpXoAxQxEGgDn2RufLrw9P",
    label: "9BkpVw…rw9P",
    blurb: "fast scalper · 90% win · 8m avg hold · +3.07 SOL/7d",
  },
  {
    wallet: "DPukTvTRvvdEJW3rMWgGqgBwhnHKa5CRxcJrqX5YgNjK",
    label: "DPukTv…gNjK",
    blurb: "mid-tf swings · 86% win · 1h 16m hold · +3.12 SOL/7d",
  },
  {
    wallet: "93fXkBiTibcNKCwaUjsYBa5yvHvPDV8jpoY5n2xfegXu",
    label: "93fXkB…egXu",
    blurb: "consistent · 70% win · 27m hold · +3.12 SOL/7d",
  },
  {
    wallet: "BTmMGmtSbChWxgGihRSf36VsszGsp1UyLJ2LfBdVRBNT",
    label: "BTmMGm…RBNT",
    blurb: "patient swing · 78% win · 5h 36m hold · +0.58 SOL/7d",
  },
  {
    wallet: "iGEn3wdMxfnvsbgTbd8T2fTgABAc3PePJQ2Knn7pZH7",
    label: "iGEn3w…pZH7",
    blurb: "high velocity · 80% win · 17m hold · +0.28 SOL/7d",
  },
];

/** First N — for tight surfaces (e.g. /start chips). */
export function topRecommended(n = 3): RecommendedLeader[] {
  return RECOMMENDED_LEADERS.slice(0, n);
}
