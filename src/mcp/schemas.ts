/**
 * Input schemas for every MCP tool stealth-trader exposes.
 *
 * Each `*Input` is a zod schema that doubles as runtime validation AND
 * the JSON-schema the LLM sees in the tool list. Keep field descriptions
 * concrete and short — the LLM reads them to decide which tool to call.
 */
import { z } from "zod";

const Wallet = z
  .string()
  .min(32)
  .max(48)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "must be base58")
  .describe("base58-encoded Solana wallet address");

const SolFloat = z
  .number()
  .positive()
  .describe("amount of SOL, e.g. 0.005");

export const getWalletInput = z.object({}).describe("Return the user's deposit address (a Solana pubkey). Send SOL here to fund the bot.");

export const getBalanceInput = z.object({}).describe("Show the user's public SOL balance available to the bot for copy-trading.");

export const getHoldingsInput = z.object({}).describe("Show the user's shielded token balances (per mint).");

export const followInput = z.object({
  leader_wallet: Wallet,
  sol_per_trade: SolFloat,
  daily_budget_sol: z.number().positive().optional()
    .describe("optional daily cap; defaults to 10 * sol_per_trade"),
}).describe("Start copying every buy from `leader_wallet`. Each leader buy triggers a private copy of `sol_per_trade` SOL. Follower's wallet never appears on-chain.");

export const unfollowInput = z.object({
  leader_wallet: Wallet,
}).describe("Stop copying a previously-followed leader.");

export const listFollowsInput = z.object({}).describe("List the user's active follows.");

export const privateBuyInput = z.object({
  mint: Wallet,
  sol: SolFloat,
}).describe("Direct private buy: spend `sol` SOL on `mint`, result lands in a shielded note. No leader, no copy logic.");

export const cashoutInput = z.object({
  recipient: Wallet,
  sol: SolFloat,
}).describe("Unshield `sol` from the shielded pool to `recipient`. The recipient has no on-chain link to the user's deposit address.");

export const discoverLeadersInput = z.object({
  candidates: z.array(Wallet).min(1).max(20)
    .describe("base58 wallets to score"),
  lookback_hours: z.number().positive().max(168).default(72)
    .describe("scoring window; default 72h"),
}).describe("Score candidate wallets by recent on-chain PnL + buy count. Returns each wallet's ranking so the agent can pick which to /follow.");

export type GetWalletInput = z.infer<typeof getWalletInput>;
export type GetBalanceInput = z.infer<typeof getBalanceInput>;
export type GetHoldingsInput = z.infer<typeof getHoldingsInput>;
export type FollowInput = z.infer<typeof followInput>;
export type UnfollowInput = z.infer<typeof unfollowInput>;
export type ListFollowsInput = z.infer<typeof listFollowsInput>;
export type PrivateBuyInput = z.infer<typeof privateBuyInput>;
export type CashoutInput = z.infer<typeof cashoutInput>;
export type DiscoverLeadersInput = z.infer<typeof discoverLeadersInput>;
