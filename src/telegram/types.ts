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

export interface CommandCtx {
  tgId: number;
  text: string;
  reply(message: string): Promise<void>;
  /** Reply with an inline keyboard. Optional so the existing CLI panels and
   *  the test recorder don't have to implement it; panels that need buttons
   *  feature-detect it and fall back to plain `reply`. */
  replyWithKeyboard?(message: string, keyboard: Keyboard): Promise<void>;
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
  cashout(args: { tgId: number; recipient: string; mint?: string }): Promise<{ txSignature: string }>;
  /** Per-note view of the shielded position. The Buy panel lists spendable
   *  wSOL notes; the Sell panel lists token notes. Each note is one tappable
   *  amount because the adapt circuit consumes exactly one note per swap. */
  getNotes?(tgId: number, mint?: string): Promise<Array<{ id: string; mint: string; amount: bigint }>>;
}

export interface Deps {
  pool: DbPool;
  authorizedTgUsers: ReadonlySet<number>;
  resolvePubkey(tgId: number): string;
  wallet?: WalletBackendCtx;
  /** Helius API key. Optional — /leader gracefully returns "set HELIUS_API_KEY"
   *  when missing instead of erroring out. */
  heliusApiKey?: string;
}
