/**
 * /holdings — list the user's shielded balances per mint.
 *
 * Reads from the wallet backend (b402 SDK call); each row is one mint
 * with summed amount across all notes. Until cost-basis is reconciled
 * against stealth.holdings, this renders raw on-chain shielded amounts
 * only — no PnL yet. PnL ships once the buy/sell panels start writing
 * the cost-basis rows.
 */
import type { CommandCtx, Deps } from "../types.js";
import { formatAmount, shortMint } from "../format.js";

export async function showHoldings(deps: Deps, ctx: CommandCtx): Promise<void> {
  if (!deps.wallet) {
    await ctx.reply("wallet backend not configured on this instance.");
    return;
  }
  try {
    const rows = await deps.wallet.getHoldings(ctx.tgId);
    if (rows.length === 0) {
      await ctx.reply("no shielded holdings.");
      return;
    }
    const lines = rows.map((h) => `${shortMint(h.mint)}  ${formatAmount(h.amount, h.decimals)}`);
    await ctx.reply(lines.join("\n"));
  } catch (e) {
    await ctx.reply(`holdings failed: ${(e as Error).message}`);
  }
}
