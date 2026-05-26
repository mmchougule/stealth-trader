/**
 * /leader <wallet> — 7-day stats for a Solana wallet.
 *
 * Pure render: pulls computed stats from leader-stats.ts, formats for
 * Telegram. Markdown-shaped fenced block so the alignment survives
 * mobile clients.
 */
import type { CommandCtx, Deps } from "../types.js";
import { getLeaderStats, type LeaderStats } from "../../leader-stats.js";
import { lamportsToSolStr, shortMint, formatHoldDuration, pad2 } from "../format.js";

export async function showLeader(deps: Deps, ctx: CommandCtx): Promise<void> {
  const parts = ctx.text.trim().split(/\s+/);
  const wallet = parts[1];
  if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    await ctx.reply("usage: /leader <wallet>");
    return;
  }
  if (!deps.heliusApiKey) {
    await ctx.reply("HELIUS_API_KEY not configured. /leader needs Helius access to read tx history.");
    return;
  }
  try {
    const stats = await getLeaderStats(wallet, deps.heliusApiKey);
    await ctx.reply(renderLeaderStats(stats));
  } catch (e) {
    await ctx.reply(`leader fetch failed: ${(e as Error).message}`);
  }
}

export function renderLeaderStats(stats: LeaderStats): string {
  const lookbackDays = Math.round(stats.lookbackSecs / 86_400);
  const lines: string[] = [`Leader ${shortMint(stats.wallet)}  ·  ${lookbackDays}-day stats`, ""];

  if (stats.buys === 0 && stats.sells === 0) {
    lines.push("No trade history in this window.");
    lines.push("");
    lines.push("This wallet either hasn't traded recently, or trades through a route Helius doesn't index as SWAP.");
    return lines.join("\n");
  }

  const decided = stats.wins + stats.losses;
  const netStr =
    stats.netClosedSolLamports >= 0n
      ? `+${lamportsToSolStr(stats.netClosedSolLamports)}`
      : lamportsToSolStr(stats.netClosedSolLamports);

  lines.push("```");
  lines.push(`  Buys              ${stats.buys}`);
  lines.push(`  Sells             ${stats.sells}`);
  lines.push(`  Closed positions  ${stats.closed.length} (${stats.wins} wins, ${stats.losses} losses)`);
  if (stats.winRatePct !== null) {
    lines.push(`  Win rate          ${stats.winRatePct}%  (${decided} decided)`);
  } else {
    lines.push(`  Win rate          n/a  (no closed positions yet)`);
  }
  lines.push(`  Net SOL P&L       ${netStr} SOL  (closed only)`);
  lines.push(`  Buy volume        ${lamportsToSolStr(stats.totalBuyVolumeLamports, 3)} SOL`);
  if (stats.avgHoldSecs !== null) {
    lines.push(`  Avg hold          ${formatHoldDuration(stats.avgHoldSecs)}`);
  }
  if (stats.bestTrade) {
    lines.push(
      `  Best trade        +${lamportsToSolStr(stats.bestTrade.pnlLamports)} SOL on ${shortMint(stats.bestTrade.mint)}`,
    );
  }
  if (stats.worstTrade && stats.worstTrade.pnlLamports < 0n) {
    lines.push(
      `  Worst trade       ${lamportsToSolStr(stats.worstTrade.pnlLamports)} SOL on ${shortMint(stats.worstTrade.mint)}`,
    );
  }
  const active = findActiveWindow(stats.hoursHistogram, stats.buys);
  if (active) {
    lines.push(
      `  Active hours      ${pad2(active.startUtc)}:00-${pad2(active.endUtc)}:00 UTC  (${active.buysInWindow}/${stats.buys} buys)`,
    );
  }
  if (stats.topMints.length > 0) {
    const top3Vol = stats.topMints.reduce((s, m) => s + m.volumeLamports, 0n);
    const pct = stats.totalBuyVolumeLamports > 0n
      ? Number((top3Vol * 100n) / stats.totalBuyVolumeLamports)
      : 0;
    lines.push(`  Top-3 mints       ${pct}% of buy volume`);
  }
  lines.push("```");
  lines.push("");
  lines.push("PnL covers closed (sold) positions only. Open positions aren't valued in v1.");
  return lines.join("\n");
}

/**
 * Hottest contiguous window of buy activity. Returns the smallest window
 * capturing >= 65% of buys; null when total buys < 4 (signal too weak to
 * surface a window).
 */
function findActiveWindow(
  hours: number[],
  totalBuys: number,
): { startUtc: number; endUtc: number; buysInWindow: number } | null {
  if (totalBuys < 4) return null;
  let best: { start: number; len: number; count: number } | null = null;
  for (let len = 1; len <= 24; len++) {
    for (let start = 0; start < 24; start++) {
      let c = 0;
      for (let k = 0; k < len; k++) c += hours[(start + k) % 24] ?? 0;
      if (c / totalBuys >= 0.65) {
        if (!best || len < best.len) best = { start, len, count: c };
        break;
      }
    }
    if (best && best.len === len) break;
  }
  if (!best) return null;
  return {
    startUtc: best.start,
    endUtc: (best.start + best.len) % 24,
    buysInWindow: best.count,
  };
}
