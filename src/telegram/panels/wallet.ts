/**
 * Wallet — Private + Public balances + deposit address + Withdraw button.
 *
 * Ported from b402-trader's Wallet view, in native SOL units (this bot never
 * shows guessed USD prices). Two sections:
 *
 *   🔒 PRIVATE  — shielded notes. Spendable via Buy / Sell / Withdraw, and
 *                 invisible on-chain. wSOL notes are summed into a SOL line;
 *                 token positions are listed per mint.
 *   🌐 PUBLIC   — the ledger SOL credited from deposits, sitting in the
 *                 derived deposit address. Funds the shield step of a buy.
 *
 * The deposit address (deterministic ed25519 from MASTER_SEED + tgId) and a
 * one-tap "Withdraw to any wallet" button round it out.
 */
import type { CommandCtx, Deps, Keyboard } from "../types.js";
import { shortMint } from "../format.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const SOL = 1_000_000_000n;

function solStr(lamports: bigint, dp = 4): string {
  return (Number(lamports) / Number(SOL)).toFixed(dp);
}

export async function showWallet(deps: Deps, ctx: CommandCtx): Promise<void> {
  const addr = deps.resolvePubkey(ctx.tgId);

  // LIVE on-chain native SOL — read fresh via RPC, never the DB ledger.
  let publicLamports = 0n;
  try {
    if (deps.publicNativeLamports) publicLamports = await deps.publicNativeLamports(ctx.tgId);
  } catch { /* show 0 on an RPC blip */ }

  // Private: shielded wSOL notes + token positions.
  let shieldedSolLamports = 0n;
  let wsolNoteCount = 0;
  let tokenLines: string[] = [];
  if (deps.wallet) {
    try {
      if (deps.wallet.getNotes) {
        const notes = await deps.wallet.getNotes(ctx.tgId, WSOL_MINT);
        shieldedSolLamports = notes.reduce((a, n) => a + n.amount, 0n);
        wsolNoteCount = notes.length;
      }
    } catch { /* skip private SOL line */ }
    try {
      const holdings = await deps.wallet.getHoldings(ctx.tgId);
      tokenLines = holdings
        .filter((h) => h.mint !== WSOL_MINT && BigInt(h.amount) > 0n)
        .map((h) => {
          const human = Number(BigInt(h.amount)) / Math.pow(10, h.decimals);
          return `  ▸ ${shortMint(h.mint)}  ${human}`;
        });
    } catch { /* skip token list */ }
  }

  const lines: string[] = ["💼 Wallet", ""];

  const hasPrivate = shieldedSolLamports > 0n || tokenLines.length > 0;
  if (hasPrivate) {
    lines.push("🔒 Private — invisible on-chain, spend via Buy / Sell / Withdraw");
    if (shieldedSolLamports > 0n) {
      lines.push(`  ▸ SOL  ${solStr(shieldedSolLamports)}  · ${wsolNoteCount} note${wsolNoteCount === 1 ? "" : "s"}`);
    }
    lines.push(...tokenLines);
  } else {
    lines.push("🔒 Private — empty. Deposit SOL and trade to mint shielded notes.");
  }

  lines.push("");
  lines.push("🌐 Public — sits in your deposit address, funds the shield step");
  lines.push(`  ▸ SOL  ${solStr(publicLamports, 6)}`);

  lines.push("");
  lines.push("Deposit address — send SOL here:");
  lines.push(addr);

  const keyboard: Keyboard = [
    [{ text: "Open in Solscan", url: `https://solscan.io/account/${addr}` }],
    [{ text: "Withdraw to any wallet", callbackData: "menu:withdraw" }],
  ];

  if (ctx.replyWithKeyboard) {
    await ctx.replyWithKeyboard(lines.join("\n"), keyboard);
  } else {
    await ctx.reply(lines.join("\n"));
  }
}
