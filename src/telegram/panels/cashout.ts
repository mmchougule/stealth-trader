/**
 * Withdraw / cashout — unshield a shielded SOL note to any address.
 *
 * The protocol unshields exactly ONE note per transaction, so withdraw is a
 * note picker, not a free-amount field — mirrors the reference trader's wd:note flow.
 *
 *   /cashout <recipient> [mint]   one-shot command (power users / scripts;
 *                                 unshields the SDK's default note).
 *   Tap "📤 Withdraw"             tap-flow: paste destination → pick which
 *                                 note → unshield that exact note. Pinning the
 *                                 note id lets the SDK reach older notes, not
 *                                 just the most-recently-shielded one.
 *
 * The wallet backend (b402 SDK) signs the unshield through the relayer, so the
 * recipient and the user's derived deposit address have no on-chain derivable
 * link — the privacy property withdraw exists to deliver.
 */
import type { CommandCtx, CallbackCtx, Deps, Keyboard } from "../types.js";
import { shortMint } from "../format.js";
import { type FlowState, clearWithdraw } from "../state.js";

const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,48}$/;
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const NOTES_SHOWN = 6;

function solStr(lamports: bigint, dp = 6): string {
  return (Number(lamports) / 1e9).toFixed(dp);
}

/** Tap "Withdraw" → arm the dest-address flow. The router's text handler
 *  checks awaitWithdrawDest BEFORE the paste-anywhere buy parse, so a pasted
 *  wallet address routes to presentWithdrawNotes, not into a buy panel. */
export async function startWithdraw(deps: Deps, flow: FlowState, ctx: CommandCtx): Promise<void> {
  if (!deps.wallet) {
    await ctx.reply("wallet backend not configured on this instance.");
    return;
  }
  flow.withdrawFlow.delete(ctx.tgId);
  flow.awaitWithdrawDest.add(ctx.tgId);
  await ctx.reply(
    [
      "Withdraw privately",
      "",
      "Paste the Solana address to send to. The relayer signs the unshield — your deposit address never appears on the transaction.",
    ].join("\n"),
  );
}

/** After the destination is pasted: validate it, list the user's spendable
 *  shielded SOL notes as buttons. Called by the router's text handler. */
export async function presentWithdrawNotes(
  deps: Deps,
  flow: FlowState,
  ctx: CommandCtx,
  dest: string,
): Promise<void> {
  if (!deps.wallet) {
    await ctx.reply("wallet backend not configured on this instance.");
    return;
  }
  if (!SOLANA_ADDR.test(dest)) {
    flow.awaitWithdrawDest.add(ctx.tgId); // stay armed for a retry
    await ctx.reply("that doesn't look like a Solana address — paste it again.");
    return;
  }
  let notes: Array<{ id: string; mint: string; amount: bigint }> = [];
  try {
    if (deps.wallet.getNotes) {
      notes = (await deps.wallet.getNotes(ctx.tgId, WSOL_MINT))
        .filter((n) => n.amount > 0n)
        .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    }
  } catch { /* fall through to empty */ }

  if (notes.length === 0) {
    clearWithdraw(flow, ctx.tgId);
    await ctx.reply("No shielded SOL notes to withdraw. Buy or sell first to mint one.");
    return;
  }

  const shown = notes.slice(0, NOTES_SHOWN);
  flow.withdrawFlow.set(ctx.tgId, {
    dest,
    notes: shown.map((n) => ({ id: n.id, amount: n.amount })),
  });

  const view = renderWithdrawNotes(dest, shown.map((n) => n.amount), notes.length);
  if (ctx.replyWithKeyboard) {
    await ctx.replyWithKeyboard(view.text, view.keyboard);
  } else {
    await ctx.reply(view.text);
  }
}

/** Pure render of the note picker. Exported for tests. */
export function renderWithdrawNotes(
  dest: string,
  amounts: bigint[],
  total: number,
): { text: string; keyboard: Keyboard } {
  const lines = [
    `Send to: ${shortMint(dest)}`,
    "",
    "Pick which note to send (each = one shielded note → one tx):",
    "",
  ];
  const keyboard: Keyboard = [];
  amounts.forEach((amount, i) => {
    lines.push(`- ${solStr(amount)} SOL`);
    keyboard.push([{ text: `Send ${solStr(amount, 4)} SOL`, callbackData: `wd:note:${i}` }]);
  });
  if (total > amounts.length) {
    lines.push("", `+${total - amounts.length} smaller notes hidden.`);
  }
  keyboard.push([{ text: "Cancel", callbackData: "wd:cancel" }]);
  return { text: lines.join("\n"), keyboard };
}

/** wd:note:<i> — unshield the chosen note to the stored destination. */
export async function onWithdrawNote(deps: Deps, flow: FlowState, ctx: CallbackCtx): Promise<void> {
  const f = flow.withdrawFlow.get(ctx.tgId);
  const idx = Number(ctx.data.split(":")[2] ?? "-1");
  if (!f || !Number.isInteger(idx) || idx < 0 || idx >= f.notes.length) {
    await ctx.answer("Note list expired — tap Withdraw again.");
    return;
  }
  if (!deps.wallet) {
    await ctx.answer();
    await ctx.editText("wallet backend not configured on this instance.");
    return;
  }
  const note = f.notes[idx]!;
  flow.withdrawFlow.delete(ctx.tgId);
  await ctx.answer();
  await ctx.editText(`Withdrawing ${solStr(note.amount, 4)} SOL...`);
  try {
    const res = await deps.wallet.cashout({ tgId: ctx.tgId, recipient: f.dest, noteId: note.id });
    flow.lastTxSig.set(ctx.tgId, res.txSignature);
    await ctx.reply(
      [
        `Sent ${solStr(note.amount, 4)} SOL to ${shortMint(f.dest)}`,
        "No on-chain link to your deposit address.",
      ].join("\n"),
      [
        [{ text: "Verify on Solscan", url: `https://solscan.io/tx/${res.txSignature}` }],
        [{ text: "Verify privacy", callbackData: "verify:last" }],
      ],
    );
  } catch (e) {
    await ctx.reply(`withdraw failed: ${(e as Error).message}`);
  }
}

/** wd:cancel — tear down the withdraw flow. */
export async function onWithdrawCancel(flow: FlowState, ctx: CallbackCtx): Promise<void> {
  clearWithdraw(flow, ctx.tgId);
  await ctx.answer();
  await ctx.editText("Cancelled.");
}

/** The one-shot /cashout command (unshields the SDK's default note). */
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

/** Shared executor for the command path — validates + unshields the default
 *  note. The tap-flow uses onWithdrawNote (pins a specific note id) instead. */
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
