/**
 * /buy <mint> <sol> — one-shot private buy.
 *
 * v0.5 shape: command-line form. The b402-trader Buy panel uses an
 * inline keyboard with note picker / amount chips / safety badge —
 * that wizard lands in a follow-up. The CLI form ships now so the
 * trade pipeline is exercisable end-to-end.
 *
 * Pipeline:
 *   1. parse + validate mint and SOL amount
 *   2. delegate to trade.executeBuy (userLock + balance.debit + backend.privateBuy)
 *   3. render the receipt (sig, tokens received) or the refund-on-failure line
 */
import type { CommandCtx, Deps } from "../types.js";
import { parseMintFromInput } from "../../parseMint.js";
import { lamportsToSolStr } from "../format.js";
import { MIN_TRADE_LAMPORTS } from "../../trade.js";

const ONE_SOL = 1_000_000_000n;

export interface BuyDeps {
  executeBuy(args: { tgId: number; mint: string; solLamports: bigint }): Promise<
    | { ok: true; txSignature: string; tokensReceived: bigint; effectiveLamports: bigint }
    | { ok: false; error: string }
  >;
}

export async function runBuy(_deps: Deps, buy: BuyDeps, ctx: CommandCtx): Promise<void> {
  const parts = ctx.text.trim().split(/\s+/).slice(1);
  if (parts.length !== 2) {
    await ctx.reply("usage: /buy <mint-or-url> <sol-amount>");
    return;
  }
  const mint = parseMintFromInput(parts[0]);
  if (!mint) {
    await ctx.reply("could not extract a mint from that input.");
    return;
  }
  const lamports = parseSolAmount(parts[1]);
  if (lamports === null) {
    await ctx.reply("invalid SOL amount. example: /buy <mint> 0.01");
    return;
  }
  if (lamports < MIN_TRADE_LAMPORTS) {
    await ctx.reply(`minimum trade size is ${lamportsToSolStr(MIN_TRADE_LAMPORTS)} SOL.`);
    return;
  }

  const res = await buy.executeBuy({ tgId: ctx.tgId, mint, solLamports: lamports });
  if (!res.ok) {
    await ctx.reply(`buy failed: ${res.error}`);
    return;
  }
  await ctx.reply(
    [
      `bought ${mint.slice(0, 6)}…${mint.slice(-4)}`,
      `spent ${lamportsToSolStr(res.effectiveLamports)} SOL`,
      `received ${res.tokensReceived.toString()} (raw units)`,
      `sig: ${res.txSignature}`,
    ].join("\n"),
  );
}

function parseSolAmount(s: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, frac = ""] = s.split(".");
  const padded = (frac + "000000000").slice(0, 9);
  try {
    return BigInt(intPart) * ONE_SOL + BigInt(padded);
  } catch {
    return null;
  }
}
