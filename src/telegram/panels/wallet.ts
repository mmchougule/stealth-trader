/**
 * /wallet — reveal the user's derived deposit address.
 *
 * The address is the deterministic ed25519 pubkey derived from
 * MASTER_SEED + tgId (see src/wallet.ts). Sending SOL/SPL here routes
 * into the bot's view; the deposit watcher credits the user's stealth
 * balance on next poll.
 */
import type { CommandCtx, Deps } from "../types.js";

export async function showWallet(deps: Deps, ctx: CommandCtx): Promise<void> {
  await ctx.reply(deps.resolvePubkey(ctx.tgId));
}
