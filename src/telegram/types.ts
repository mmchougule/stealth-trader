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

export interface CommandCtx {
  tgId: number;
  text: string;
  reply(message: string): Promise<void>;
}

export interface WalletBackendCtx {
  getHoldings(tgId: number): Promise<Array<{ mint: string; amount: string; decimals: number }>>;
  cashout(args: { tgId: number; recipient: string; mint?: string }): Promise<{ txSignature: string }>;
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
