/**
 * /holdings — list shielded token positions, each with a one-tap "Sell"
 * button (the `sell:mint:<mint>` callback the router wires up) and, when the
 * cost-basis ledger is available, a PnL line.
 *
 * Two data sources, deliberately:
 *   - localHoldings (stealth.holdings) → what the user PAID (cost basis), the
 *     source for PnL. Native SOL units, no guessed USD.
 *   - quoteSolOut → current value of the position via a Jupiter quote.
 * Falls back to the SDK shielded view (getHoldings, no PnL) when the ledger
 * isn't wired, so a bare instance still renders.
 */
import type { CommandCtx, Deps, Keyboard } from "../types.js";
import { formatAmount, shortMint, lamportsToSolStr } from "../format.js";

/** One render row. value/invested optional → PnL line only when both known. */
export interface HoldingRow {
  mint: string;
  amount: string;
  decimals: number;
  symbol?: string | null;
  /** Current value of the whole position in lamports (from a quote). */
  valueLamports?: bigint;
  /** Net SOL invested in lamports (cost basis from the ledger). */
  investedLamports?: bigint;
}

/** Pure render: holdings rows → text + per-token Sell buttons. Exported for
 *  tests so the layout is checked without grammy. */
export function renderHoldings(rows: HoldingRow[]): { text: string; keyboard: Keyboard } {
  const lines: string[] = [];
  const keyboard: Keyboard = [];
  let row: Keyboard[number] = [];
  for (const h of rows) {
    const sym = h.symbol ?? shortMint(h.mint);
    lines.push(`${shortMint(h.mint)}  ${formatAmount(h.amount, h.decimals)}`);
    if (h.valueLamports !== undefined) {
      lines.push(`   ≈ ${lamportsToSolStr(h.valueLamports, 6)} SOL`);
    }
    // PnL only when we know both what it's worth and what was paid.
    if (h.valueLamports !== undefined && h.investedLamports !== undefined && h.investedLamports > 0n) {
      const pnl = h.valueLamports - h.investedLamports;
      const sign = pnl >= 0n ? "+" : "-";
      const abs = pnl >= 0n ? pnl : -pnl;
      const pct = Number((pnl * 10000n) / h.investedLamports) / 100;
      lines.push(`   PnL: ${sign}${lamportsToSolStr(abs, 6)} SOL  (${pnl >= 0n ? "+" : ""}${pct.toFixed(1)}%)`);
    }
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
    const rows = await buildRows(deps, ctx.tgId);
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

/** Prefer the cost-basis ledger (PnL); fall back to the SDK shielded view. */
async function buildRows(deps: Deps, tgId: number): Promise<HoldingRow[]> {
  const w = deps.wallet!;
  if (w.localHoldings) {
    const ledger = await w.localHoldings(tgId);
    return Promise.all(
      ledger.map(async (h) => {
        let valueLamports: bigint | undefined;
        if (w.quoteSolOut) {
          const q = await w.quoteSolOut(h.mint, BigInt(h.amount)).catch(() => null);
          if (q !== null) valueLamports = q;
        }
        return {
          mint: h.mint,
          amount: h.amount,
          decimals: h.decimals,
          symbol: h.symbol,
          ...(valueLamports !== undefined ? { valueLamports } : {}),
          investedLamports: h.totalInvestedLamports,
        };
      }),
    );
  }
  // No ledger wired — SDK shielded view, no PnL.
  const sdkRows = await w.getHoldings(tgId);
  return sdkRows.map((h) => ({ mint: h.mint, amount: h.amount, decimals: h.decimals }));
}
