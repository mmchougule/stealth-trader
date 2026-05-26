/**
 * /discover — surface a curated short-list of recently-profitable wallets
 * so a new user has a starting point before they hunt for their own.
 *
 * Read-only: just prints the curated list with each wallet's blurb. The
 * follow flow (/follow <wallet>) is v0.6 — for now the user can paste a
 * wallet from /discover into /leader to confirm fresh stats.
 */
import type { CommandCtx, Deps } from "../types.js";
import { RECOMMENDED_LEADERS } from "../../discover-leaders.js";
import { shortMint } from "../format.js";

export async function showDiscover(_deps: Deps, ctx: CommandCtx): Promise<void> {
  if (RECOMMENDED_LEADERS.length === 0) {
    await ctx.reply(
      [
        "No curated leaders configured for this bot.",
        "",
        "Check any wallet's 7-day stats yourself:",
        "  /leader <wallet>",
        "",
        "Operators: set STEALTH_DISCOVER_LEADERS to seed a starter list.",
      ].join("\n"),
    );
    return;
  }
  const lines: string[] = [
    "Top vetted leaders (7-day):",
    "",
  ];
  for (const r of RECOMMENDED_LEADERS) {
    lines.push(`${shortMint(r.wallet)}  ${r.blurb}`);
  }
  lines.push("");
  lines.push("Paste any of these into /leader <wallet> for fresh stats.");
  await ctx.reply(lines.join("\n"));
}
