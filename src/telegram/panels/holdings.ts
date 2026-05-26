/**
 * /holdings — list the user's shielded balances per mint, each with a
 * one-tap "Sell" button that drops into the Sell panel's per-token note
 * list (the `sell:mint:<mint>` callback the router wires up).
 *
 * Reads from the wallet backend (b402 SDK call); each row is one mint with
 * summed amount across all notes. Cost-basis / PnL ships once reconciled
 * against stealth.holdings; this renders raw shielded amounts only.
 */
import type { CommandCtx, Deps, Keyboard } from "../types.js";
import { formatAmount, shortMint } from "../format.js";

/** Pure render: holdings rows → text + per-token Sell buttons. Exported for
 *  tests so the layout is checked without grammy. */
export function renderHoldings(
  rows: Array<{ mint: string; amount: string; decimals: number; symbol?: string | null }>,
): { text: string; keyboard: Keyboard } {
  const lines: string[] = [];
  const keyboard: Keyboard = [];
  let row: Keyboard[number] = [];
  for (const h of rows) {
    const sym = h.symbol ?? shortMint(h.mint);
    lines.push(`${shortMint(h.mint)}  ${formatAmount(h.amount, h.decimals)}`);
    row.push({ text: `Sell ${sym}`, callbackData: `sell:mint:${h.mint}` });
    if (row.length === 2) { keyboard.push(row); row = []; }
  }
  if (row.length) keyboard.push(row);
  return { text: lines.join("\n"), keyboard };
}

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
    const view = renderHoldings(rows);
    if (ctx.replyWithKeyboard && view.keyboard.length > 0) {
      await ctx.replyWithKeyboard(view.text, view.keyboard);
    } else {
      await ctx.reply(view.text);
    }
  } catch (e) {
    await ctx.reply(`holdings failed: ${(e as Error).message}`);
  }
}
