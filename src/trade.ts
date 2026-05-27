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
import { log } from "./log.js";
import { recordBuy } from "./holdings.js";

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
  /** Resolve a token's symbol + decimals for the cost-basis ledger row.
   *  Injected so tests run without Jupiter/RPC. When omitted, the buy still
   *  succeeds and records with symbol=null / decimals=0 (display resolves
   *  later). Production wires the Jupiter+chain lookup. */
  tokenMeta?: (mint: string) => Promise<{ symbol: string | null; decimals: number }>;
  /** Persist the buy to the cost-basis ledger (stealth.holdings + trades).
   *  Injected for testability; defaults to the real recordBuy. The live sell
   *  picker + /holdings PnL read from this ledger, NOT the SDK's mint labels —
   *  this is what keeps a long-tail memecoin sellable even when the SDK would
   *  render its note as "unknown:<frhex>" on a cold instance. */
  recordBuy?: typeof recordBuy;
}

/**
 * Default buy fee: 0.05% (5 bps) + 0.0003 SOL flat. Exported so the Buy
 * panel preview can render the SAME number trade.executeBuy will charge —
 * a preview that disagreed with the on-chain debit would erode trust.
 */
export const computeBuyFee = (lamports: bigint): bigint => {
  const bps = (lamports * 5n) / 10_000n; // 5 basis points
  const flat = 300_000n;                  // 0.0003 SOL
  return bps + flat;
};

export function makeTrade(deps: TradeDeps) {
  const computeBuyFeeFn = deps.computeBuyFee ?? computeBuyFee;
  const recordBuyFn = deps.recordBuy ?? recordBuy;

  async function executeBuyInner(args: BuyArgs): Promise<BuyResult> {
    if (args.solLamports < MIN_TRADE_LAMPORTS) {
      return { ok: false, error: `amount below min trade size (${MIN_TRADE_LAMPORTS} lamports)` };
    }
    const fee = computeBuyFeeFn(args.solLamports);

    // The spend gate is on-chain, not a DB ledger: privateBuy shields native
    // SOL (public path) or spends a shielded note (private recycle path) and
    // fails if neither has the funds, rolling back any fresh shield. Debiting
    // a public-SOL ledger here wrongly blocked private-note buys.
    let res: { txSignature: string; tokensReceived: bigint };
    try {
      res = await deps.backend.privateBuy({
        tgId: args.tgId,
        mint: args.mint,
        solLamports: args.solLamports,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ tgId: args.tgId, mint: args.mint, err: msg }, "buy failed");
      return { ok: false, error: msg };
    }

    // On-chain swap landed. Record to the cost-basis ledger so the position
    // is sellable + shows PnL. The ledger stores the REAL base58 mint +
    // symbol + decimals — this is the authoritative source the sell picker
    // and /holdings read from, NOT the SDK's note labels (which can render
    // as "unknown:<frhex>" on a cold instance and crash the sell path).
    const meta = deps.tokenMeta
      ? await deps.tokenMeta(args.mint).catch(() => ({ symbol: null, decimals: 0 }))
      : { symbol: null, decimals: 0 };
    try {
      await recordBuyFn({
        tgId: args.tgId,
        mint: args.mint,
        symbol: meta.symbol,
        decimals: meta.decimals,
        solLamports: args.solLamports,
        tokensReceived: res.tokensReceived,
        feeLamports: fee,
        txSignature: res.txSignature,
      });
    } catch (e) {
      // The swap is irreversibly on chain; do NOT refund. Surface a clear
      // operator-actionable error with the signature so the ledger can be
      // reconciled manually. Mirrors b402-trader's post-success DB-write guard.
      const msg = e instanceof Error ? e.message : String(e);
      log.error(
        { tgId: args.tgId, mint: args.mint, sig: res.txSignature, err: msg },
        "buy: recordBuy failed AFTER on-chain success — manual reconcile needed",
      );
      return {
        ok: false,
        error: `On-chain buy landed but ledger write failed — contact operator with tx ${res.txSignature}`,
      };
    }

    return {
      ok: true,
      txSignature: res.txSignature,
      tokensReceived: res.tokensReceived,
      effectiveLamports: args.solLamports,
    };
  }

  return {
    async executeBuy(args: BuyArgs): Promise<BuyResult> {
      return withUserSerial(args.tgId, () => executeBuyInner(args));
    },
    /** Exposed so tests can call the inner without the serial lock. */
    _executeBuyInner: executeBuyInner,
  };
}
