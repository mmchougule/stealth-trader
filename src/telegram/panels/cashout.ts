/**
 * Withdraw / cashout — unshield to any address.
 *
 * Two entry shapes, same executor:
 *   /cashout <recipient> [mint]   one-shot command (power users / scripts).
 *   Tap "📤 Withdraw"             tap-flow: prompts for a destination address,
 *                                 the router's text handler feeds it back to
 *                                 executeCashout. Mirrors b402-trader's
 *                                 Withdraw button.
 *
 * The wallet backend (b402 SDK) signs the unshield through the relayer, so the
 * recipient and the user's derived deposit address have no on-chain derivable
 * link — that's the privacy property withdraw exists to deliver.
 */
import type { CommandCtx, Deps } from "../types.js";
import { shortMint } from "../format.js";
import type { FlowState } from "../state.js";

const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,48}$/;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Tap "Withdraw" → arm the dest-address flow + show what's available. The
 *  router's text handler checks awaitWithdrawDest BEFORE the paste-anywhere
 *  buy parse, so a pasted wallet address routes here, not into a buy panel. */
export async function startWithdraw(deps: Deps, flow: FlowState, ctx: CommandCtx): Promise<void> {
  if (!deps.wallet) {
    await ctx.reply("wallet backend not configured on this instance.");
    return;
  }
  // Best-effort: show spendable shielded SOL so the prompt isn't blind.
  let avail = "";
  try {
    if (deps.wallet.getNotes) {
      const notes = await deps.wallet.getNotes(ctx.tgId, WSOL_MINT);
      const total = notes.reduce((a, n) => a + n.amount, 0n);
      if (total > 0n) avail = `\n\nPrivate SOL available: ${(Number(total) / 1e9).toFixed(4)} SOL`;
    }
  } catch { /* prompt without the balance line */ }

  flow.awaitWithdrawDest.add(ctx.tgId);
  await ctx.reply(
    [
      "Withdraw privately",
      "",
      "Paste the Solana address to send to. The relayer signs the unshield — your deposit address never appears on the transaction.",
      avail,
    ].join("\n").trimEnd(),
  );
}

/** The one-shot /cashout command. */
export async function runCashout(deps: Deps, ctx: CommandCtx): Promise<void> {
  if (!deps.wallet) {
    await ctx.reply("wallet backend not configured on this instance.");
    return;
  }
  const args = ctx.text.trim().split(/\s+/).slice(1);
  if (args.length < 1 || args.length > 2) {
    await ctx.reply("usage: /cashout <recipient-wallet> [mint]");
    return;
  }
  const [recipient, mint] = args;
  await executeCashout(deps, ctx, recipient!, mint);
}

/** Shared executor — validates the recipient and unshields. Used by both the
 *  command and the Withdraw tap-flow (router feeds the pasted address here). */
export async function executeCashout(
  deps: Deps,
  ctx: CommandCtx,
  recipient: string,
  mint?: string,
): Promise<void> {
  if (!deps.wallet) {
    await ctx.reply("wallet backend not configured on this instance.");
    return;
  }
  if (!SOLANA_ADDR.test(recipient)) {
    await ctx.reply("invalid recipient — must be a base58 Solana address. Paste it again, or /cashout <address>.");
    return;
  }
  try {
    const res = await deps.wallet.cashout({
      tgId: ctx.tgId,
      recipient,
      ...(mint ? { mint } : {}),
    });
    await ctx.reply(
      [
        `unshielded to ${shortMint(recipient)}`,
        `sig: ${res.txSignature}`,
        `no on-chain link to your deposit address.`,
      ].join("\n"),
    );
  } catch (e) {
    await ctx.reply(`cashout failed: ${(e as Error).message}`);
  }
}
