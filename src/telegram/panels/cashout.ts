/**
 * /cashout <recipient> [mint] — unshield to any address.
 *
 * v0.5 shape: one-shot command. Validation:
 *   - recipient must be a base58 Solana address (32-48 chars)
 *   - optional mint argument; default is wSOL (relayer unwraps to SOL)
 *
 * The wallet backend (b402 SDK) signs the unshield through the relayer
 * so the recipient and the user's derived address have no on-chain
 * derivable link — that's the privacy property /cashout exists to
 * deliver.
 *
 * The interactive paste-then-confirm wizard (b402-trader's /cashout)
 * lands in a follow-up commit; for v0.5 the one-shot form ships.
 */
import type { CommandCtx, Deps } from "../types.js";
import { shortMint } from "../format.js";

const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,48}$/;

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
  if (!SOLANA_ADDR.test(recipient)) {
    await ctx.reply("invalid recipient — must be a base58 Solana address.");
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
