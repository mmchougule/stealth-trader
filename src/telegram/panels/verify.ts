/**
 * /verify [sig] + the "Verify privacy" button. Proves the privacy property on
 * chain: fetches the tx and shows that the user's derived key is NOT in its
 * accountKeys — the relayer signed it, so no one can tie the trade to them.
 */
import type { CommandCtx, Deps } from "../types.js";
import type { FlowState } from "../state.js";

function short(s: string): string {
  return s.length > 16 ? `${s.slice(0, 12)}…${s.slice(-4)}` : s;
}

export async function showVerify(deps: Deps, flow: FlowState, ctx: CommandCtx): Promise<void> {
  if (!deps.verifyTx) {
    await ctx.reply("verification not configured on this instance.");
    return;
  }
  const arg = ctx.text.trim().split(/\s+/)[1];
  const sig = arg ?? flow.lastTxSig.get(ctx.tgId);
  if (!sig) {
    await ctx.reply("Trade something first, or: /verify <tx-signature>");
    return;
  }
  const r = await deps.verifyTx(ctx.tgId, sig).catch(() => null);
  if (!r) {
    await ctx.reply("Tx not found yet (still indexing) — try again in a few seconds.");
    return;
  }
  const lines = [
    `Verification — ${short(sig)}`,
    "",
    "accounts in this transaction:",
    ...r.accounts.slice(0, 12).map((a) => `  ${short(a)}${a === r.userPk ? "  ← YOUR KEY (LEAK)" : ""}`),
    ...(r.accounts.length > 12 ? [`  +${r.accounts.length - 12} more`] : []),
    "",
    `your deposit key (${short(r.userPk)}):`,
    r.userInTx ? "  PRESENT — privacy broken, flag the operator" : "  NOT in this transaction.",
    "",
    r.userInTx
      ? "Privacy FAILED."
      : "Private. Your wallet does not appear on this trade — only the relayer does.",
  ];
  await ctx.reply(lines.join("\n"));
}
