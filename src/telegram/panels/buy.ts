/**
 * Buy panel — tap-to-trade inline keyboard, ported from b402-trader's
 * showBuyPanel.
 *
 * Two entry shapes:
 *   /buy <mint> <sol>   one-shot CLI fast-path (parse → rugcheck → execute).
 *                       Kept so power users / scripts don't lose the form.
 *   /buy <mint>         opens the inline panel: two funding sections, tap an
 *                       amount, see a preview, confirm. No typing.
 *
 * The panel surfaces both ways to fund a buy:
 *   PRIVATE  — spend one existing shielded SOL note exactly (no shield step).
 *              Top notes are shown 2-at-a-time with a paginator.
 *   PUBLIC   — shield fresh public SOL + swap. % chips of the spendable
 *              public balance (25 / 50 / 75 / Max).
 *
 * Tapping a note or chip → preview (spend / get / fee / total) → "Buy now"
 * routes through trade.executeBuy (NOT backend.privateBuy) so the SOL ledger
 * debit-before-send + refund-on-failure stays correct. The rugcheck gate runs
 * on panel-open and again is implied before execution via the gate that
 * blocked the panel — a danger token never reaches a buy button.
 *
 * The render functions are pure ({ text, keyboard }) so the panel layout is
 * unit-tested without grammy. The handlers take a CallbackCtx and the same
 * injected deps as the command, keeping every external call (RPC, quote,
 * rugcheck, notes) wrapped.
 */
import type { CommandCtx, CallbackCtx, Deps, Keyboard } from "../types.js";
import { parseMintFromInput } from "../../parseMint.js";
import { lamportsToSolStr, shortMint, formatNum, rugcheckBadge } from "../format.js";
import { MIN_TRADE_LAMPORTS } from "../../trade.js";
import { checkToken } from "../../safety.js";
import {
  type FlowState,
  type BuyTab,
  clearBuy,
} from "../state.js";

const ONE_SOL = 1_000_000_000n;

/** Headroom kept in the public balance for the shield ATA / tx fee on the
 *  public buy path. Mirrors b402-trader's RESERVE_SOL. */
const RESERVE_LAMPORTS = 3_000_000n; // 0.003 SOL
const NOTES_PER_PAGE = 2;

export interface BuyExecResult {
  ok: true;
  txSignature: string;
  tokensReceived: bigint;
  effectiveLamports: bigint;
}
export type BuyResult = BuyExecResult | { ok: false; error: string };

/**
 * Injected backend the panel composes on. `executeBuy` is the only path to
 * on-chain state (it owns the ledger debit + refund). The rest are
 * read-only lookups that the panel wraps individually so any one failing
 * degrades gracefully (e.g. no quote → preview shows "~?").
 */
export interface BuyDeps {
  executeBuy(args: { tgId: number; mint: string; solLamports: bigint }): Promise<BuyResult>;
  /** Public SOL balance (lamports) the user can spend — the DB ledger. */
  publicSolLamports(tgId: number): Promise<bigint>;
  /** Spendable shielded wSOL notes (lamports), any order. */
  shieldedSolNotes(tgId: number): Promise<bigint[]>;
  /** Token symbol + decimals for the header / preview. null symbol is fine. */
  tokenMeta(mint: string): Promise<{ symbol: string | null; decimals: number }>;
  /** Estimated tokens out for `solLamports` in. null = quote unavailable. */
  quoteTokensOut(mint: string, solLamports: bigint, decimals: number): Promise<bigint | null>;
  /** Protocol fee for a buy of `solLamports`. Mirrors trade.computeBuyFee. */
  computeBuyFee(solLamports: bigint): bigint;
}

// ---------------------------------------------------------------------------
// Pure render: the panel keyboard + text. Exported for tests.
// ---------------------------------------------------------------------------

export interface PanelView {
  text: string;
  keyboard: Keyboard;
  /** The note sizes (lamports) the panel rendered buttons for, largest-first.
   *  The caller persists this into BuyFlow so `buy:note:<i>` resolves the
   *  exact amount without it riding in callback_data. */
  notes: bigint[];
}

/**
 * Build the Buy panel view for a token. Pure: callers pass the already-
 * fetched balances + meta, so this never touches the network and is fully
 * unit-testable.
 */
export function renderBuyPanel(args: {
  mint: string;
  symbol: string | null;
  publicSolLamports: bigint;
  shieldedNotes: bigint[];
  rugScore: number | undefined;
  noteOffset: number;
}): PanelView {
  const { mint, symbol, publicSolLamports, rugScore } = args;

  // Largest-first; only notes that clear the min trade size are spendable.
  const notes = [...args.shieldedNotes]
    .filter((n) => n >= MIN_TRADE_LAMPORTS)
    .sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const totalShielded = notes.reduce((a, n) => a + n, 0n);

  const publicUsable = publicSolLamports > RESERVE_LAMPORTS
    ? publicSolLamports - RESERVE_LAMPORTS
    : 0n;
  const pcts = [25, 50, 75, 100].filter(
    (p) => (publicUsable * BigInt(p)) / 100n >= MIN_TRADE_LAMPORTS,
  );

  const hasNotes = notes.length > 0;
  const hasPublic = pcts.length > 0;

  const lines: string[] = [
    `Buy ${symbol ? `$${symbol}` : shortMint(mint)}`,
    mint,
    `Dexscreener: https://dexscreener.com/solana/${mint}`,
    `Birdeye: https://birdeye.so/token/${mint}?chain=solana`,
    `Solscan: https://solscan.io/token/${mint}`,
    rugcheckBadge(rugScore),
    "",
  ];
  if (hasNotes) {
    lines.push(`🔒 PRIVATE — ${lamportsToSolStr(totalShielded)} SOL across ${notes.length} note${notes.length === 1 ? "" : "s"}`);
  }
  if (hasPublic) {
    lines.push(`🌐 PUBLIC — ${lamportsToSolStr(publicSolLamports)} SOL`);
  }
  if (!hasNotes && !hasPublic) {
    lines.push("Not enough SOL yet — deposit at least 0.005 SOL to start buying.");
  }

  const keyboard: Keyboard = [];

  // PRIVATE notes — paginated, NOTES_PER_PAGE per view, 🔒 per-button marker.
  if (hasNotes) {
    const offset = ((args.noteOffset % notes.length) + notes.length) % notes.length;
    const page = notes.slice(offset, offset + NOTES_PER_PAGE);
    const row: Keyboard[number] = [];
    page.forEach((amount, i) => {
      const absIdx = offset + i;
      row.push({ text: `🔒 ${lamportsToSolStr(amount)} SOL`, callbackData: `buy:note:${absIdx}` });
    });
    if (row.length) keyboard.push(row);
    if (notes.length > NOTES_PER_PAGE) {
      const nextOffset = (offset + NOTES_PER_PAGE) % notes.length;
      const remaining = notes.length - (offset + page.length);
      const label = remaining > 0
        ? `🔒 More notes (${remaining} more) →`
        : "🔒 Start over ↺";
      keyboard.push([{ text: label, callbackData: `buy:notes:more:${nextOffset}` }]);
    }
  }

  // PUBLIC % chips — 🌐 per-button marker. callbackData carries the exact
  // lamports so the chosen amount can't drift between render and tap.
  if (hasPublic) {
    const row: Keyboard[number] = [];
    for (const p of pcts) {
      const amt = (publicUsable * BigInt(p)) / 100n;
      const label = p === 100
        ? `🌐 Max (${lamportsToSolStr(amt)})`
        : `🌐 ${p}% (${lamportsToSolStr(amt)})`;
      row.push({ text: label, callbackData: `buy:amt:${amt.toString()}` });
    }
    keyboard.push(row);
  }

  keyboard.push([{ text: "Cancel", callbackData: "buy:cancel" }]);
  return { text: lines.join("\n"), keyboard, notes };
}

/** The preview shown after an amount is chosen. Pure. */
export function renderBuyPreview(args: {
  symbol: string | null;
  solLamports: bigint;
  feeLamports: bigint;
  estTokensOut: bigint | null;
  decimals: number;
}): { text: string; keyboard: Keyboard } {
  const { symbol, solLamports, feeLamports, estTokensOut, decimals } = args;
  const totalLamports = solLamports + feeLamports;
  const estStr = estTokensOut === null
    ? "?"
    : formatNum(Number(estTokensOut) / Math.pow(10, decimals));
  const text = [
    "Buy preview",
    "",
    `Spend:  ${lamportsToSolStr(solLamports)} SOL`,
    `Get:    ~${estStr} ${symbol ? `$${symbol}` : "tokens"}`,
    `Fee:    ${lamportsToSolStr(feeLamports, 6)} SOL  (0.05% + 0.0003 SOL flat)`,
    `Total:  ${lamportsToSolStr(totalLamports)} SOL out of your balance`,
  ].join("\n");
  const keyboard: Keyboard = [[
    { text: "Buy now", callbackData: "buy:confirm" },
    { text: "Cancel", callbackData: "buy:cancel" },
  ]];
  return { text, keyboard };
}

// ---------------------------------------------------------------------------
// Command: /buy
// ---------------------------------------------------------------------------

export async function runBuy(
  _deps: Deps,
  buy: BuyDeps,
  state: FlowState,
  ctx: CommandCtx,
): Promise<void> {
  const parts = ctx.text.trim().split(/\s+/).slice(1);
  if (parts.length === 0) {
    await ctx.reply("usage: /buy <mint-or-url> [sol-amount]");
    return;
  }
  const mint = parseMintFromInput(parts[0]);
  if (!mint) {
    await ctx.reply("could not extract a mint from that input.");
    return;
  }

  // Fast-path: explicit amount → one-shot CLI buy (rugcheck → execute).
  if (parts.length >= 2) {
    await runBuyCli(buy, ctx, mint, parts[1]);
    return;
  }

  // No amount → open the inline panel.
  await openBuyPanel(buy, state, ctx, mint);
}

/** One-shot CLI buy. Preserves the v0.5 form + its rugcheck gate exactly. */
async function runBuyCli(buy: BuyDeps, ctx: CommandCtx, mint: string, amountArg: string): Promise<void> {
  const lamports = parseSolAmount(amountArg);
  if (lamports === null) {
    await ctx.reply("invalid SOL amount. example: /buy <mint> 0.01");
    return;
  }
  if (lamports < MIN_TRADE_LAMPORTS) {
    await ctx.reply(`minimum trade size is ${lamportsToSolStr(MIN_TRADE_LAMPORTS)} SOL.`);
    return;
  }
  // RugCheck gate. checkToken is fail-open (unreachable / error → pass) so an
  // outage never blocks legit buys, but a confirmed danger verdict aborts
  // before any SOL moves. Matches b402-trader's buy guard.
  const safety = await checkToken(mint);
  if (!safety.pass) {
    await ctx.reply(`blocked: ${safety.reason}\n\nif you still want it, this token failed an automated rug check.`);
    return;
  }
  const res = await buy.executeBuy({ tgId: ctx.tgId, mint, solLamports: lamports });
  if (!res.ok) {
    await ctx.reply(`buy failed: ${res.error}`);
    return;
  }
  await ctx.reply(
    [
      `bought ${shortMint(mint)}`,
      `spent ${lamportsToSolStr(res.effectiveLamports)} SOL`,
      `received ${res.tokensReceived.toString()} (raw units)`,
      `sig: ${res.txSignature}`,
    ].join("\n"),
  );
}

/**
 * Open the inline panel. Runs the rugcheck gate (danger → abort, never show a
 * buy button for a flagged token), fetches balances + notes + meta in
 * parallel, persists the flow state, and renders. Every external call is
 * wrapped — a failure replies a readable line instead of throwing into the
 * polling loop.
 */
async function openBuyPanel(
  buy: BuyDeps,
  state: FlowState,
  ctx: CommandCtx,
  mint: string,
): Promise<void> {
  // RugCheck gate FIRST — a danger token must not reach the panel at all.
  const safety = await checkToken(mint);
  if (!safety.pass) {
    await ctx.reply(`blocked: ${safety.reason}\n\nif you still want it, this token failed an automated rug check.`);
    return;
  }

  const [meta, publicLamports, notes] = await Promise.all([
    buy.tokenMeta(mint).catch(() => ({ symbol: null, decimals: 6 })),
    buy.publicSolLamports(ctx.tgId).catch(() => 0n),
    buy.shieldedSolNotes(ctx.tgId).catch(() => [] as bigint[]),
  ]);

  const view = renderBuyPanel({
    mint,
    symbol: meta.symbol,
    publicSolLamports: publicLamports,
    shieldedNotes: notes,
    rugScore: safety.score,
    noteOffset: 0,
  });

  state.buyFlow.set(ctx.tgId, {
    mint,
    symbol: meta.symbol,
    decimals: meta.decimals,
    tab: "notes" as BuyTab,
    noteOffset: 0,
    notes: view.notes,
  });

  await replyKb(ctx, view.text, view.keyboard);
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

/** buy:cancel — tear down the flow and replace the panel with a terse line. */
export async function onBuyCancel(state: FlowState, ctx: CallbackCtx): Promise<void> {
  clearBuy(state, ctx.tgId);
  await ctx.answer();
  await ctx.editText("Cancelled.");
}

/** buy:notes:more:<offset> — advance the private-notes paginator in place. */
export async function onBuyNotesMore(
  buy: BuyDeps,
  state: FlowState,
  ctx: CallbackCtx,
): Promise<void> {
  const f = state.buyFlow.get(ctx.tgId);
  if (!f) {
    await ctx.answer("Flow expired. Tap Buy again.");
    return;
  }
  const nextOffset = Number(ctx.data.split(":")[3] ?? "0");
  const [publicLamports, notes, score] = await Promise.all([
    buy.publicSolLamports(ctx.tgId).catch(() => 0n),
    buy.shieldedSolNotes(ctx.tgId).catch(() => f.notes),
    Promise.resolve(undefined as number | undefined),
  ]);
  const view = renderBuyPanel({
    mint: f.mint,
    symbol: f.symbol,
    publicSolLamports: publicLamports,
    shieldedNotes: notes,
    rugScore: score,
    noteOffset: nextOffset,
  });
  state.buyFlow.set(ctx.tgId, { ...f, noteOffset: nextOffset, notes: view.notes });
  await ctx.answer();
  await ctx.editText(view.text, view.keyboard);
}

/** buy:tab:<notes|public> — record the tab choice + re-render. The panel
 *  shows both sections at once, so the tab is a soft preference; we keep the
 *  callback so the b402-trader contract is honored and future single-section
 *  layouts can branch on it. */
export async function onBuyTab(
  buy: BuyDeps,
  state: FlowState,
  ctx: CallbackCtx,
): Promise<void> {
  const f = state.buyFlow.get(ctx.tgId);
  if (!f) {
    await ctx.answer("Flow expired. Tap Buy again.");
    return;
  }
  const tab = (ctx.data.split(":")[2] ?? "notes") as BuyTab;
  if (f.tab === tab) {
    await ctx.answer();
    return;
  }
  const [publicLamports, notes] = await Promise.all([
    buy.publicSolLamports(ctx.tgId).catch(() => 0n),
    buy.shieldedSolNotes(ctx.tgId).catch(() => f.notes),
  ]);
  const view = renderBuyPanel({
    mint: f.mint,
    symbol: f.symbol,
    publicSolLamports: publicLamports,
    shieldedNotes: notes,
    rugScore: undefined,
    noteOffset: f.noteOffset,
  });
  state.buyFlow.set(ctx.tgId, { ...f, tab, notes: view.notes });
  await ctx.answer();
  await ctx.editText(view.text, view.keyboard);
}

/** buy:note:<i> — preview spending the shielded note at index i. */
export async function onBuyNote(
  buy: BuyDeps,
  state: FlowState,
  ctx: CallbackCtx,
): Promise<void> {
  const f = state.buyFlow.get(ctx.tgId);
  if (!f) {
    await ctx.answer("Flow expired. Tap Buy.");
    return;
  }
  const idx = Number(ctx.data.split(":")[2] ?? "-1");
  if (!Number.isInteger(idx) || idx < 0 || idx >= f.notes.length) {
    await ctx.answer("Note list expired — tap Buy again.");
    return;
  }
  await showPreview(buy, state, ctx, f.notes[idx]!);
}

/** buy:amt:<lamports> — preview a public-funded buy of the chosen amount. */
export async function onBuyAmount(
  buy: BuyDeps,
  state: FlowState,
  ctx: CallbackCtx,
): Promise<void> {
  const f = state.buyFlow.get(ctx.tgId);
  if (!f) {
    await ctx.answer("Flow expired. Tap Buy.");
    return;
  }
  let lamports: bigint;
  try {
    lamports = BigInt(ctx.data.split(":")[2] ?? "0");
  } catch {
    await ctx.answer("Bad amount — tap Buy again.");
    return;
  }
  if (lamports < MIN_TRADE_LAMPORTS) {
    await ctx.answer("Below minimum trade size.");
    return;
  }
  await showPreview(buy, state, ctx, lamports);
}

async function showPreview(
  buy: BuyDeps,
  state: FlowState,
  ctx: CallbackCtx,
  lamports: bigint,
): Promise<void> {
  const f = state.buyFlow.get(ctx.tgId)!;
  const estTokensOut = await buy.quoteTokensOut(f.mint, lamports, f.decimals).catch(() => null);
  const feeLamports = buy.computeBuyFee(lamports);
  state.pendingBuy.set(ctx.tgId, {
    mint: f.mint,
    symbol: f.symbol,
    solLamports: lamports,
    decimals: f.decimals,
  });
  state.buyFlow.delete(ctx.tgId);
  const view = renderBuyPreview({
    symbol: f.symbol,
    solLamports: lamports,
    feeLamports,
    estTokensOut,
    decimals: f.decimals,
  });
  await ctx.answer();
  await ctx.editText(view.text, view.keyboard);
}

/** buy:confirm — execute via trade.executeBuy, render receipt or failure. */
export async function onBuyConfirm(
  buy: BuyDeps,
  state: FlowState,
  ctx: CallbackCtx,
): Promise<void> {
  const p = state.pendingBuy.get(ctx.tgId);
  if (!p) {
    await ctx.answer("Preview expired.");
    return;
  }
  state.pendingBuy.delete(ctx.tgId);
  await ctx.answer();
  await ctx.editText("Buying...");

  const res = await buy.executeBuy({ tgId: ctx.tgId, mint: p.mint, solLamports: p.solLamports });
  if (!res.ok) {
    await ctx.reply(`buy failed: ${res.error}`);
    return;
  }
  const tokensHuman = formatNum(Number(res.tokensReceived) / Math.pow(10, p.decimals));
  const sym = p.symbol ? `$${p.symbol}` : shortMint(p.mint);
  await ctx.reply(
    [
      `Bought ${tokensHuman} ${sym}`,
      `spent ${lamportsToSolStr(res.effectiveLamports)} SOL · shielded`,
      "",
      "Your wallet does not appear on this trade.",
    ].join("\n"),
    [[{ text: "Verify on Solscan", url: `https://solscan.io/tx/${res.txSignature}` }]],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reply with a keyboard when the ctx supports it, else fall back to text. */
async function replyKb(ctx: CommandCtx, text: string, keyboard: Keyboard): Promise<void> {
  if (ctx.replyWithKeyboard) {
    await ctx.replyWithKeyboard(text, keyboard);
  } else {
    await ctx.reply(text);
  }
}

export function parseSolAmount(s: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, frac = ""] = s.split(".");
  const padded = (frac + "000000000").slice(0, 9);
  try {
    return BigInt(intPart) * ONE_SOL + BigInt(padded);
  } catch {
    return null;
  }
}
