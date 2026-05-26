/**
 * Sell panel — tap-to-trade inline keyboard, ported from b402-trader's
 * sell:start / sell:note flow.
 *
 * Entry shapes:
 *   /sell <mint> <raw-amount>   one-shot CLI fast-path (raw token units).
 *   /sell                       lists the user's shielded token holdings as
 *                               buttons; tapping one lists that token's
 *                               spendable notes.
 *   (a "Sell <SYM>" button rendered by the Holdings panel jumps straight to
 *    the per-token note list — same `sell:mint:<mint>` callback.)
 *
 * Each shielded token note is ONE tappable amount: the b402 adapt circuit
 * consumes exactly one note per swap, so we never pretend a 50% slider works
 * — we list the real note denominations (top 3 by size; smaller change notes
 * ride along in the holdings total). Tap a note → preview (sell / get) →
 * "Sell now" → backend.privateSell → receipt.
 *
 * Render functions are pure ({ text, keyboard }) for unit tests; handlers
 * take a CallbackCtx + injected deps so every external call (notes, quote,
 * swap) is wrapped and a failure can't escape into the polling loop.
 */
import type { CommandCtx, CallbackCtx, Deps, Keyboard } from "../types.js";
import { parseMintFromInput } from "../../parseMint.js";
import { lamportsToSolStr, shortMint, formatNum } from "../format.js";
import { type FlowState, type SellableNote, clearSell } from "../state.js";

/** Show at most this many notes per token — Phase-9 change notes pile up;
 *  the top few by size are the ones worth selling. */
const NOTES_SHOWN = 3;

export interface SellExecResult {
  ok: true;
  txSignature: string;
  solReceived: bigint;
}
export type SellResult = SellExecResult | { ok: false; error: string };

export interface SellDeps {
  /** Execute the private sell of one token note. Optional so an instance
   *  without the backend wired still type-checks (CLI replies a hint). */
  executeSell?(args: { tgId: number; mint: string; rawAmount: bigint }): Promise<SellResult>;
  /** Shielded holdings, one row per mint, for the token picker. */
  holdings(tgId: number): Promise<Array<{ mint: string; amount: string; decimals: number; symbol: string | null }>>;
  /** Spendable notes for one mint (raw token units). */
  tokenNotes(tgId: number, mint: string): Promise<bigint[]>;
  /** Estimated SOL out (lamports) for selling `rawAmount`. null = no quote. */
  quoteSolOut(mint: string, rawAmount: bigint): Promise<bigint | null>;
}

// ---------------------------------------------------------------------------
// Pure render
// ---------------------------------------------------------------------------

/** The token-picker keyboard for `/sell` with no mint. */
export function renderSellTokenList(
  holdings: Array<{ mint: string; amount: string; decimals: number; symbol: string | null }>,
): { text: string; keyboard: Keyboard } {
  if (holdings.length === 0) {
    return { text: "no shielded holdings to sell.", keyboard: [] };
  }
  const lines = ["Sell which token?", ""];
  const keyboard: Keyboard = [];
  let row: Keyboard[number] = [];
  for (const h of holdings) {
    const sym = h.symbol ?? shortMint(h.mint);
    const human = formatNum(Number(BigInt(h.amount)) / Math.pow(10, h.decimals));
    lines.push(`${sym}: ${human}`);
    row.push({ text: `Sell ${sym}`, callbackData: `sell:mint:${h.mint}` });
    if (row.length === 2) { keyboard.push(row); row = []; }
  }
  if (row.length) keyboard.push(row);
  return { text: lines.join("\n"), keyboard };
}

/** The per-token note list. `notes` is raw token units, any order. Returns
 *  the rendered (top-N, largest-first) notes so the caller can persist them
 *  for index-based callback resolution. */
export function renderSellNotes(args: {
  mint: string;
  symbol: string | null;
  decimals: number;
  notes: bigint[];
}): { text: string; keyboard: Keyboard; shown: bigint[] } {
  const { mint, symbol, decimals } = args;
  const sorted = [...args.notes].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const shown = sorted.slice(0, NOTES_SHOWN);
  if (shown.length === 0) {
    return {
      text: `${symbol ? `$${symbol}` : shortMint(mint)} — nothing spendable yet. Try again in a few seconds.`,
      keyboard: [],
      shown,
    };
  }
  const lines = [
    `Sell ${symbol ? `$${symbol}` : shortMint(mint)}`,
    "",
    "Pick a denomination (each is one shielded note):",
    "",
  ];
  const keyboard: Keyboard = [];
  shown.forEach((amount, i) => {
    const label = `${formatNum(Number(amount) / Math.pow(10, decimals))} ${symbol ?? ""}`.trim();
    lines.push(`- ${label}`);
    keyboard.push([{ text: `Sell ${label}`, callbackData: `sell:note:${i}` }]);
  });
  keyboard.push([{ text: "Cancel", callbackData: "sell:cancel" }]);
  return { text: lines.join("\n"), keyboard, shown };
}

/** Preview for selling one note. Pure. */
export function renderSellPreview(args: {
  symbol: string | null;
  rawAmount: bigint;
  decimals: number;
  estSolOut: bigint | null;
  totalRaw: bigint;
}): { text: string; keyboard: Keyboard } {
  const { symbol, rawAmount, decimals, estSolOut, totalRaw } = args;
  const human = formatNum(Number(rawAmount) / Math.pow(10, decimals));
  const estStr = estSolOut === null ? "?" : lamportsToSolStr(estSolOut, 6);
  const lines = [
    "Sell preview",
    "",
    `Sell:  ${human} ${symbol ? `$${symbol}` : ""}`.trimEnd(),
    `Get:   ~${estStr} SOL`,
  ];
  if (totalRaw > rawAmount) {
    const remaining = formatNum(Number(totalRaw - rawAmount) / Math.pow(10, decimals));
    lines.push("", `Spending one note. You'll keep ${remaining} ${symbol ?? ""} in smaller notes after this trade.`.trimEnd());
  }
  const keyboard: Keyboard = [[
    { text: "Sell now", callbackData: "sell:confirm" },
    { text: "Cancel", callbackData: "sell:cancel" },
  ]];
  return { text: lines.join("\n"), keyboard };
}

// ---------------------------------------------------------------------------
// Command: /sell
// ---------------------------------------------------------------------------

export async function runSell(
  _deps: Deps,
  sell: SellDeps,
  _state: FlowState,
  ctx: CommandCtx,
): Promise<void> {
  const parts = ctx.text.trim().split(/\s+/).slice(1);

  // No args → open the token picker.
  if (parts.length === 0) {
    const holdings = await sell.holdings(ctx.tgId).catch(() => []);
    const view = renderSellTokenList(holdings);
    await replyKb(ctx, view.text, view.keyboard);
    return;
  }

  // <mint> <raw-amount> → one-shot CLI sell.
  if (parts.length !== 2) {
    await ctx.reply("usage: /sell <mint-or-url> <raw-amount>  (or /sell to pick from a list)");
    return;
  }
  const mint = parseMintFromInput(parts[0]);
  if (!mint) {
    await ctx.reply("could not extract a mint from that input.");
    return;
  }
  let rawAmount: bigint;
  try {
    rawAmount = BigInt(parts[1]!);
  } catch {
    await ctx.reply("amount must be an integer in raw token units (see /holdings).");
    return;
  }
  if (rawAmount <= 0n) {
    await ctx.reply("amount must be positive.");
    return;
  }
  if (!sell.executeSell) {
    await ctx.reply("sell backend not wired on this instance. Use /cashout to unshield SOL directly.");
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
      `received ${lamportsToSolStr(res.solReceived, 6)} SOL`,
      `sig: ${res.txSignature}`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

/** sell:mint:<mint> — load the token's notes and show the note list. */
export async function onSellMint(
  sell: SellDeps,
  state: FlowState,
  ctx: CallbackCtx,
): Promise<void> {
  await ctx.answer();
  const mint = ctx.data.slice("sell:mint:".length);
  if (!mint) {
    await ctx.reply("Nothing to sell.");
    return;
  }
  const holdings = await sell.holdings(ctx.tgId).catch(() => []);
  const h = holdings.find((x) => x.mint === mint);
  if (!h) {
    await ctx.reply("Nothing to sell.");
    return;
  }
  const notes = await sell.tokenNotes(ctx.tgId, mint).catch(() => [] as bigint[]);
  const view = renderSellNotes({ mint, symbol: h.symbol, decimals: h.decimals, notes });
  if (view.shown.length === 0) {
    await ctx.reply(view.text);
    return;
  }
  state.sellFlow.set(ctx.tgId, {
    mint,
    symbol: h.symbol,
    decimals: h.decimals,
    notes: view.shown.map<SellableNote>((amount) => ({
      mint, amount, symbol: h.symbol, decimals: h.decimals,
    })),
  });
  await ctx.reply(view.text, view.keyboard);
}

/** sell:note:<i> — preview selling the note at index i. */
export async function onSellNote(
  sell: SellDeps,
  state: FlowState,
  ctx: CallbackCtx,
): Promise<void> {
  const f = state.sellFlow.get(ctx.tgId);
  const idx = Number(ctx.data.split(":")[2] ?? "-1");
  if (!f || !Number.isInteger(idx) || idx < 0 || idx >= f.notes.length) {
    await ctx.answer("Note list expired — tap Sell again.");
    return;
  }
  const note = f.notes[idx]!;
  const totalRaw = f.notes
    .filter((n) => n.mint === note.mint)
    .reduce((a, n) => a + n.amount, 0n);
  const estSolOut = await sell.quoteSolOut(note.mint, note.amount).catch(() => null);

  state.pendingSell.set(ctx.tgId, {
    mint: note.mint,
    symbol: note.symbol,
    decimals: note.decimals,
    tokenAmount: note.amount,
  });
  state.sellFlow.delete(ctx.tgId);

  const view = renderSellPreview({
    symbol: note.symbol,
    rawAmount: note.amount,
    decimals: note.decimals,
    estSolOut,
    totalRaw,
  });
  await ctx.answer();
  await ctx.editText(view.text, view.keyboard);
}

/** sell:cancel — tear down + replace the message. */
export async function onSellCancel(state: FlowState, ctx: CallbackCtx): Promise<void> {
  clearSell(state, ctx.tgId);
  await ctx.answer();
  await ctx.editText("Cancelled.");
}

/** sell:confirm — execute via backend.privateSell, render receipt. */
export async function onSellConfirm(
  sell: SellDeps,
  state: FlowState,
  ctx: CallbackCtx,
): Promise<void> {
  const p = state.pendingSell.get(ctx.tgId);
  if (!p) {
    await ctx.answer("Preview expired.");
    return;
  }
  if (!sell.executeSell) {
    state.pendingSell.delete(ctx.tgId);
    await ctx.answer();
    await ctx.editText("sell backend not wired on this instance.");
    return;
  }
  state.pendingSell.delete(ctx.tgId);
  await ctx.answer();
  await ctx.editText("Selling...");

  const res = await sell.executeSell({ tgId: ctx.tgId, mint: p.mint, rawAmount: p.tokenAmount });
  if (!res.ok) {
    await ctx.reply(`sell failed: ${res.error}`);
    return;
  }
  await ctx.reply(
    [
      `Sold for +${lamportsToSolStr(res.solReceived, 6)} SOL`,
      "",
      "SOL landed in a fresh shielded note — no link to your sell.",
    ].join("\n"),
    // Receipt chaining, mirroring the post-buy keyboard: Verify (link), then
    // re-enter without typing — Withdraw cashes out, Holdings re-lists.
    [
      [{ text: "Verify on Solscan", url: `https://solscan.io/tx/${res.txSignature}` }],
      [
        { text: "Withdraw", callbackData: "menu:withdraw" },
        { text: "Holdings", callbackData: "menu:holdings" },
      ],
    ],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function replyKb(ctx: CommandCtx, text: string, keyboard: Keyboard): Promise<void> {
  if (ctx.replyWithKeyboard && keyboard.length > 0) {
    await ctx.replyWithKeyboard(text, keyboard);
  } else {
    await ctx.reply(text);
  }
}
