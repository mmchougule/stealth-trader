/**
 * Public types for the copy-trade pipeline.
 *
 * The flow:
 *   Helius webhook → parseSwap (decode) → executeBuy (shield + swap)
 *
 * `HeliusEnhancedTx` is the subset of Helius's enriched transaction payload
 * the parser actually reads — we don't pull in their full type to keep this
 * package zero-dependency on Helius internals.
 */

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface HeliusEnhancedTx {
  signature: string;
  slot: number;
  feePayer: string;
  type?: string;
  source?: string;
  timestamp?: number;
  events?: {
    swap?: unknown;
  };
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
    rawTokenAmount?: { tokenAmount: string; decimals: number };
  }>;
}

export interface ParsedSwap {
  /** Wallet that signed and paid for the swap (the "leader"). */
  wallet: string;
  /** Always WSOL_MINT in v0.1 — we only parse SOL → token buys. */
  tokenIn: string;
  /** Output token mint the leader received. */
  tokenOut: string;
  /** Lamports of SOL the leader spent (sum of native + wSOL transfers OUT). */
  amountIn: bigint;
  /** Raw token units the leader received (0n if the source didn't supply
   *  rawTokenAmount, e.g. PUMP_FUN with float-only amounts). */
  leaderTokensOut: bigint;
  /** Decimals from the rawTokenAmount payload. 0 when unknown. */
  leaderTokenDecimals: number;
  /** Transaction signature. */
  signature: string;
  /** Slot the swap landed in. */
  slot: number;
  /** Unix seconds, if Helius provided it. */
  timestamp: number | null;
}

export interface Follow {
  id: number;
  followerTg: number;
  leaderWallet: string;
  /** Lamports of SOL to spend per leader buy. */
  perTradeLamports: bigint;
  active: boolean;
}

export interface CopyOutcome {
  followId: number;
  leaderSig: string;
  mint: string;
  amountLamports: bigint;
  status: "success" | "skipped" | "failed";
  /** Tx signature of the copy buy when status=success. */
  followerSig?: string;
  reason?: string;
}

// Re-export the FollowStore interface so callers can import it from
// either `./types` or `./execute`. Kept here so `src/follows.ts` doesn't
// have to deep-import from `./copy-trade/execute`.
export interface FollowStore {
  activeForLeader(leader: string): Promise<Follow[]>;
  alreadyLogged(followId: number, leaderSig: string): Promise<boolean>;
  insertLog(row: CopyOutcome): Promise<void>;
  dailySpent(followId: number): Promise<bigint>;
  dailyBudget(followId: number): Promise<bigint>;
}
