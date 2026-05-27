/**
 * Per-user flow state for the inline-keyboard Buy / Sell panels.
 *
 * The CLI commands (`/buy <mint> <sol>`) are stateless — parse args, execute,
 * reply. The tap-to-trade panels are not: a Buy spans paste-CA → pick
 * note/amount → preview → confirm, with the chosen amount and the notes
 * list living between callback round-trips. Telegram's callback_data is
 * capped at 64 bytes, so a 44-byte mint + a bigint amount won't fit inline;
 * we key everything by tgId here instead and put only short indices /
 * offsets in callback_data.
 *
 * Lifecycle: every map entry is created on panel-open and removed on
 * confirm / cancel / expire. `clearBuy` / `clearSell` are the single
 * teardown points the callbacks call so nothing leaks across flows.
 *
 * Bounded: one entry per active user. A stale entry costs a few hundred
 * bytes and is overwritten the next time that user opens the panel; it is
 * never iterated, so growth is O(active users), not O(taps).
 */

/** Which funding source the Buy panel is showing buttons for. */
export type BuyTab = "notes" | "public";

/** Buy flow: a mint is locked in; the user is choosing how much to spend.
 *  `tab` + `noteOffset` drive the private-notes paginator across re-renders. */
export interface BuyFlow {
  mint: string;
  symbol: string | null;
  decimals: number;
  tab: BuyTab;
  noteOffset: number;
  /** Spendable shielded wSOL notes (lamports), largest-first, captured when
   *  the panel rendered. `buy:note:<i>` indexes into this — the exact note
   *  size must survive the round-trip so the preview can't drift. */
  notes: bigint[];
}

/** Buy preview shown, awaiting the "Buy now" tap. */
export interface PendingBuy {
  mint: string;
  symbol: string | null;
  solLamports: bigint;
  decimals: number;
}

/** One tappable shielded token note in the Sell flow. The adapt circuit
 *  consumes exactly one note per swap, so each button maps to one note. */
export interface SellableNote {
  mint: string;
  amount: bigint;
  symbol: string | null;
  decimals: number;
}

/** Sell flow: the user picked a token; these are its spendable notes,
 *  indexed by `sell:note:<i>`. */
export interface SellFlow {
  mint: string;
  symbol: string | null;
  decimals: number;
  notes: SellableNote[];
}

/** Sell preview shown, awaiting the "Sell now" tap. */
export interface PendingSell {
  mint: string;
  symbol: string | null;
  decimals: number;
  tokenAmount: bigint;
}

/** Withdraw flow: a destination is locked in; the user is picking which
 *  shielded SOL note to unshield. One note per tx, so each button is one note;
 *  `id` pins it for the SDK so older notes are reachable (not rightmost-only).
 *  Indexed by `wd:note:<i>` into `notes`. */
export interface WithdrawNote {
  id: string;
  amount: bigint;
}
export interface WithdrawFlow {
  dest: string;
  notes: WithdrawNote[];
}

/**
 * The mutable surface the router owns and threads into the callback
 * handlers. Kept as one object so tests can construct a fresh, isolated
 * state per case instead of reaching into module-level singletons.
 */
export interface FlowState {
  buyFlow: Map<number, BuyFlow>;
  pendingBuy: Map<number, PendingBuy>;
  sellFlow: Map<number, SellFlow>;
  pendingSell: Map<number, PendingSell>;
  /** Withdraw: destination + the note list shown, awaiting a note tap. */
  withdrawFlow: Map<number, WithdrawFlow>;
  /** Last on-chain tx signature per user, for the "Verify privacy" button. */
  lastTxSig: Map<number, string>;
  /** Users who tapped "Buy" on the menu and now owe a pasted contract
   *  address. The next plain-text message from a member of this set is
   *  treated as a CA → opens the buy panel. Mirrors the reference trader's
   *  buyFlow.step === "await_ca". Cleared once the CA is consumed. */
  awaitBuyCa: Set<number>;
  /** Users who tapped "Withdraw" and now owe a pasted destination address.
   *  Checked BEFORE awaitBuyCa / paste-anywhere in the text router because a
   *  wallet address is base58 and would otherwise parse as a token mint and
   *  wrongly open a buy panel. The next message from this set is the cashout
   *  recipient. Cleared once consumed. */
  awaitWithdrawDest: Set<number>;
}

export function makeFlowState(): FlowState {
  return {
    buyFlow: new Map(),
    pendingBuy: new Map(),
    sellFlow: new Map(),
    pendingSell: new Map(),
    withdrawFlow: new Map(),
    lastTxSig: new Map(),
    awaitBuyCa: new Set(),
    awaitWithdrawDest: new Set(),
  };
}

/** Drop every buy-related entry for a user (cancel / confirm / expire). */
export function clearBuy(state: FlowState, tgId: number): void {
  state.buyFlow.delete(tgId);
  state.pendingBuy.delete(tgId);
  state.awaitBuyCa.delete(tgId);
}

/** Drop every sell-related entry for a user. */
export function clearSell(state: FlowState, tgId: number): void {
  state.sellFlow.delete(tgId);
  state.pendingSell.delete(tgId);
}

/** Drop every withdraw-related entry for a user. */
export function clearWithdraw(state: FlowState, tgId: number): void {
  state.withdrawFlow.delete(tgId);
  state.awaitWithdrawDest.delete(tgId);
}
