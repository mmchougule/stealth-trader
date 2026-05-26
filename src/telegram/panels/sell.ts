/**
 * /sell <mint> <raw-amount> — one-shot private sell.
 *
 * v0.5 shape: command-line form. raw-amount is in raw token units (no
 * decimals applied) — same as the SDK takes. Most users will get this
 * value from /holdings output; the inline-keyboard wizard with %
 * chips lands in the next pass.
 *
 * Pipeline gap: the SwapBackend interface only has privateBuy today.
 * privateSell is a SwapBackend method we wire here as a placeholder
 * until the backend exposes it. Reply text spells out the gap so the
 * user knows it's a v0.6 item rather than a silent stub.
 */
import type { CommandCtx, Deps } from "../types.js";
import { parseMintFromInput } from "../../parseMint.js";
import { shortMint } from "../format.js";

export interface SellDeps {
  /** Optional — present only when the backend implements private sell. */
  executeSell?(args: { tgId: number; mint: string; rawAmount: bigint }): Promise<
    | { ok: true; txSignature: string; solReceived: bigint }
    | { ok: false; error: string }
  >;
}

export async function runSell(_deps: Deps, sell: SellDeps, ctx: CommandCtx): Promise<void> {
  const parts = ctx.text.trim().split(/\s+/).slice(1);
  if (parts.length !== 2) {
    await ctx.reply("usage: /sell <mint-or-url> <raw-amount>");
    return;
  }
  const mint = parseMintFromInput(parts[0]);
  if (!mint) {
    await ctx.reply("could not extract a mint from that input.");
    return;
  }
  let rawAmount: bigint;
  try {
    rawAmount = BigInt(parts[1]);
  } catch {
    return void ctx.reply("amount must be an integer in raw token units (see /holdings).");
  }
  if (rawAmount <= 0n) {
    await ctx.reply("amount must be positive.");
    return;
  }
  if (!sell.executeSell) {
    await ctx.reply(
      "sell backend not wired yet — v0.6 work. For now, use /cashout to unshield directly.",
    );
    return;
  }
  const res = await sell.executeSell({ tgId: ctx.tgId, mint, rawAmount });
  if (!res.ok) {
    await ctx.reply(`sell failed: ${res.error}`);
    return;
  }
  await ctx.reply(
    [
      `sold ${shortMint(mint)} for SOL`,
      `received ${res.solReceived.toString()} lamports`,
      `sig: ${res.txSignature}`,
    ].join("\n"),
  );
}
