/**
 * Shared types for the Telegram surface.
 *
 * CommandCtx is the test-friendly subset of grammy's Context that every
 * panel/handler accepts. bot.ts adapts the real grammy ctx to this shape;
 * tests construct it inline.
 *
 * Deps is the bundle of injected services (DbPool, wallet backend,
 * resolvePubkey, etc.) the router hands to each panel. Panels never
 * reach across module boundaries to import config or pool — every
 * external state goes through Deps so the panels stay unit-testable.
 */
import type { DbPool } from "../db/index.js";

/**
 * One inline-keyboard button. `text` is the visible label; exactly one of
 * `callbackData` (tap → callbackQuery) or `url` (tap → open link) is set.
 * Rows of these make up an InlineKeyboard. This is the panel-facing shape;
 * the router maps it onto grammy's InlineKeyboard so panels never import
 * grammy and stay unit-testable.
 */
export interface Button {
  text: string;
  callbackData?: string;
  url?: string;
}

/** A keyboard is rows of buttons. Empty rows are dropped by the adapter. */
export type Keyboard = Button[][];

/**
 * A persistent reply-keyboard menu: rows of plain button labels that dock at
 * the bottom of the chat (grammy `Keyboard`, not `InlineKeyboard`). Tapping a
 * label sends that label as a normal text message, which `bot.hears` catches.
 * This is the always-visible Buy / Sell / Wallet / Withdraw bar — the thing
 * that lets a user trade without typing a single command.
 */
export type MenuKeyboard = string[][];

export interface CommandCtx {
  tgId: number;
  text: string;
  reply(message: string): Promise<void>;
  /** Reply with an inline keyboard. Optional so the existing CLI panels and
   *  the test recorder don't have to implement it; panels that need buttons
   *  feature-detect it and fall back to plain `reply`. */
  replyWithKeyboard?(message: string, keyboard: Keyboard): Promise<void>;
  /** Reply and dock a persistent reply-keyboard menu at the bottom of the
   *  chat. Optional for the same reason as replyWithKeyboard — CLI panels and
   *  test recorders don't implement it. */
  replyWithMenu?(message: string, menu: MenuKeyboard): Promise<void>;
}

/**
 * The context a callbackQuery handler receives. Mirrors CommandCtx but adds
 * the bits a tap needs: the callback `data` string, editing the message the
 * button is attached to, and acknowledging the query (Telegram requires an
 * answerCallbackQuery within a few seconds or the client shows a spinner
 * forever). Test recorders implement the same shape; the router adapts the
 * real grammy callback ctx.
 */
export interface CallbackCtx {
  tgId: number;
  /** The callback_data of the tapped button (e.g. "buy:note:1"). */
  data: string;
  /** Acknowledge the tap. `text`, if given, shows as a toast. Idempotent —
   *  safe to call once per handler even on the error path. */
  answer(text?: string): Promise<void>;
  /** Edit the message the keyboard is attached to. Used to advance a flow
   *  in place (panel → preview → receipt) instead of spamming new messages. */
  editText(message: string, keyboard?: Keyboard): Promise<void>;
  /** Send a fresh message (receipts, errors that shouldn't clobber the panel). */
  reply(message: string, keyboard?: Keyboard): Promise<void>;
}

export interface WalletBackendCtx {
  getHoldings(tgId: number): Promise<Array<{ mint: string; amount: string; decimals: number }>>;
  /** Unshield to `recipient`. `noteId` pins the exact shielded note to spend
   *  (the SDK consumes one note per unshield tx; omitting it falls back to the
   *  SDK's most-recently-shielded note, which can't reach older notes without
   *  an indexer). The Withdraw note-picker always passes a noteId. */
  cashout(args: { tgId: number; recipient: string; mint?: string; noteId?: string }): Promise<{ txSignature: string }>;
  /** Per-note view of the shielded position. The Buy panel lists spendable
   *  wSOL notes; the Sell panel lists token notes; the Withdraw picker lists
   *  wSOL notes. Each note is one tappable amount because the adapt/unshield
   *  circuits consume exactly one note per tx. `id` pins the note for cashout. */
  getNotes?(tgId: number, mint?: string): Promise<Array<{ id: string; mint: string; amount: bigint }>>;
  /** Local cost-basis ledger (stealth.holdings): per-mint amount + total SOL
   *  invested, the source for PnL. Distinct from getHoldings (SDK shielded
   *  view) — this carries what the user PAID. Optional so a bare instance
   *  still type-checks; the holdings panel degrades to no-PnL without it. */
  localHoldings?(tgId: number): Promise<Array<{ mint: string; amount: string; decimals: number; symbol: string | null; totalInvestedLamports: bigint }>>;
  /** Estimated SOL out (lamports) for selling `rawAmount` of `mint`. Used to
   *  value holdings for PnL. null = no quote. */
  quoteSolOut?(mint: string, rawAmount: bigint): Promise<bigint | null>;
}

export interface Deps {
  pool: DbPool;
  authorizedTgUsers: ReadonlySet<number>;
  resolvePubkey(tgId: number): string;
  wallet?: WalletBackendCtx;
  /** LIVE on-chain native SOL (lamports) at the user's derived deposit
   *  address — read fresh via Solana RPC on every call, like b402-trader's
   *  getAccountSnapshot.publicSol. Wallet + /balance display this, NOT the DB
   *  ledger, so the user always sees real on-chain state. */
  publicNativeLamports?(tgId: number): Promise<bigint>;
  /** Fetch a confirmed tx and report whether the user's derived key appears in
   *  its accountKeys — the on-chain proof the relayer (not the user) signed it.
   *  null = tx not found yet (still indexing). */
  verifyTx?(tgId: number, sig: string): Promise<{
    accounts: string[];
    signers: string[];
    userInTx: boolean;
    userPk: string;
  } | null>;
  /** Helius API key. Optional — /leader gracefully returns "set HELIUS_API_KEY"
   *  when missing instead of erroring out. */
  heliusApiKey?: string;
}
