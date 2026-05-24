/**
 * Buy/Sell orchestration. Everything between "user clicked the button"
 * and "SDK signs the tx" lives here:
 *
 *   1. Per-user serialization (userLock).
 *   2. Atomic debit-before-send: deduct `lamports + fee` from the
 *      user's SOL balance inside one Postgres tx. If the row update
 *      affects zero rows (insufficient balance), abort before any
 *      network calls.
 *   3. Compute the protocol fee (`computeBuyFee`).
 *   4. Delegate the actual shield + swap to the b402 client.
 *   5. On any swap failure, refund the full debit + fee back into
 *      the user's balance with a `buy_refund` ledger entry.
 *
 * The b402 client is injected — tests pass a mock so the entire flow
 * runs without RPC, Helius, or Postgres.
 */
import { withUserSerial } from "./userLock.js";

export const MIN_TRADE_LAMPORTS = 1_000_000n; // 0.001 SOL hard floor

export interface BuyArgs {
  tgId: number;
  mint: string;
  solLamports: bigint;
}

export type BuyResult =
  | {
      ok: true;
      txSignature: string;
      tokensReceived: bigint;
      effectiveLamports: bigint;
    }
  | { ok: false; error: string };

export interface SwapBackend {
  /** Execute a private buy of `mint` for `solLamports`. Returns the
   *  txSignature of the on-chain swap + the tokens received. */
  privateBuy(args: {
    tgId: number;
    mint: string;
    solLamports: bigint;
  }): Promise<{ txSignature: string; tokensReceived: bigint }>;
}

export interface BalanceStore {
  /** Atomic debit. Returns true if `lamports` was successfully reserved. */
  debit(tgId: number, lamports: bigint, reason: string): Promise<boolean>;
  /** Pure credit. Never fails on insufficient balance. */
  credit(tgId: number, lamports: bigint, reason: string, txSignature?: string): Promise<void>;
}

export interface TradeDeps {
  backend: SwapBackend;
  balance: BalanceStore;
  /** Fee policy. Default: 0.05% + 0.0003 SOL flat. */
  computeBuyFee?: (lamports: bigint) => bigint;
}

const defaultBuyFee = (lamports: bigint): bigint => {
  const bps = (lamports * 5n) / 10_000n; // 5 basis points
  const flat = 300_000n;                  // 0.0003 SOL
  return bps + flat;
};

export function makeTrade(deps: TradeDeps) {
  const computeBuyFee = deps.computeBuyFee ?? defaultBuyFee;

  async function executeBuyInner(args: BuyArgs): Promise<BuyResult> {
    if (args.solLamports < MIN_TRADE_LAMPORTS) {
      return { ok: false, error: `amount below min trade size (${MIN_TRADE_LAMPORTS} lamports)` };
    }
    const fee = computeBuyFee(args.solLamports);
    const totalDebit = args.solLamports + fee;

    const debited = await deps.balance.debit(args.tgId, totalDebit, "buy");
    if (!debited) return { ok: false, error: "insufficient SOL balance" };

    try {
      const res = await deps.backend.privateBuy({
        tgId: args.tgId,
        mint: args.mint,
        solLamports: args.solLamports,
      });
      return {
        ok: true,
        txSignature: res.txSignature,
        tokensReceived: res.tokensReceived,
        effectiveLamports: args.solLamports,
      };
    } catch (e) {
      // Refund EVERYTHING — swap input AND fee — atomically. Without
      // this, a swap failure silently consumes user balance.
      await deps.balance.credit(args.tgId, totalDebit, "buy_refund").catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  return {
    async executeBuy(args: BuyArgs): Promise<BuyResult> {
      return withUserSerial(args.tgId, () => executeBuyInner(args));
    },
    /** Exposed so tests can call the inner without the serial lock. */
    _executeBuyInner: executeBuyInner,
  };
}
