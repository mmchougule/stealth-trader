/**
 * Telegram command router. Wires grammy's Bot instance to the per-panel
 * handlers. The router owns:
 *
 *   - the authorization middleware (deny anyone not in authorizedTgUsers)
 *   - the /start + /help home message
 *   - the /balance command (DB-backed, kept simple for v0.5)
 *   - the inline-keyboard callbackQuery handlers for Buy / Sell
 *   - delegation to panels/* for everything else
 *
 * Adding a new panel = (a) new file under panels/, (b) one wire-up line in
 * registerHandlers. Callback handlers register the same way via `onCallback`.
 *
 * The router is the ONLY place that touches grammy. Panels speak CommandCtx /
 * CallbackCtx (see types.ts) so they stay unit-testable; the adapters below
 * map the real grammy ctx onto those shapes and the panel Keyboard onto a
 * grammy InlineKeyboard.
 */
import { Bot, InlineKeyboard, Keyboard as ReplyKeyboard, type Context } from "grammy";
import type { Deps, CommandCtx, CallbackCtx, Keyboard, MenuKeyboard } from "./types.js";
import { log } from "../log.js";
import { parseMintFromInput } from "../parseMint.js";
import { showWallet } from "./panels/wallet.js";
import { showHoldings } from "./panels/holdings.js";
import { showLeader } from "./panels/leader.js";
import { showDiscover } from "./panels/discover.js";
import {
  runCashout, startWithdraw, presentWithdrawNotes, onWithdrawNote, onWithdrawCancel,
} from "./panels/cashout.js";
import {
  runBuy, openBuyPanel, type BuyDeps,
  onBuyCancel, onBuyNote, onBuyAmount, onBuyTab, onBuyNotesMore, onBuyConfirm,
} from "./panels/buy.js";
import {
  runSell, openSellTokenList, type SellDeps,
  onSellMint, onSellNote, onSellCancel, onSellConfirm,
} from "./panels/sell.js";
import { makeFlowState, type FlowState } from "./state.js";

// The persistent reply-keyboard menu. These four labels are the entire
// no-typing surface: tapping one sends the label as a text message, caught by
// the bot.hears handlers below. Layout + emojis mirror b402-trader's
// mainMenu() so the two bots feel identical.
//   Buy / Sell      — the two trade primitives.
//   Wallet / Withdraw — fund + exit (the privacy unlock).
const MENU_BUY = "🟢 Buy";
const MENU_SELL = "🔴 Sell";
const MENU_WALLET = "💼 Wallet";
const MENU_WITHDRAW = "📤 Withdraw";
const MAIN_MENU: MenuKeyboard = [
  [MENU_BUY, MENU_SELL],
  [MENU_WALLET, MENU_WITHDRAW],
];

/** Map the panel-facing MenuKeyboard onto grammy's persistent ReplyKeyboard. */
function toReplyKeyboard(menu: MenuKeyboard): ReplyKeyboard {
  const kb = new ReplyKeyboard();
  for (const row of menu) {
    for (const label of row) kb.text(label);
    kb.row();
  }
  return kb.resized().persistent();
}

const SOL = 1_000_000_000n;

export interface RouterDeps extends Deps {
  buy: BuyDeps;
  sell: SellDeps;
}

/** Map a panel Keyboard (Button[][]) onto a grammy InlineKeyboard. Empty
 *  rows are skipped. Exactly one of callbackData / url is expected per
 *  button; callbackData wins if both are somehow set. */
function toInlineKeyboard(kb: Keyboard): InlineKeyboard {
  const ik = new InlineKeyboard();
  for (const row of kb) {
    if (row.length === 0) continue;
    for (const b of row) {
      if (b.callbackData !== undefined) ik.text(b.text, b.callbackData);
      else if (b.url !== undefined) ik.url(b.text, b.url);
    }
    ik.row();
  }
  return ik;
}

export function registerHandlers(bot: Bot, deps: RouterDeps): void {
  // One flow-state surface for the whole process. Maps are keyed by tgId and
  // torn down on cancel/confirm, so memory is O(active users).
  const flow = makeFlowState();

  const auth = (ctx: Context): boolean => {
    const id = ctx.from?.id;
    if (id && deps.authorizedTgUsers.has(id)) return true;
    void ctx.reply("not authorized").catch(() => {});
    return false;
  };

  const cmd = (ctx: Context): CommandCtx => ({
    tgId: ctx.from?.id ?? 0,
    text: ctx.message?.text ?? "",
    reply: async (m) => { await ctx.reply(m); },
    replyWithKeyboard: async (m, kb) => {
      await ctx.reply(m, { reply_markup: toInlineKeyboard(kb), link_preview_options: { is_disabled: true } });
    },
    replyWithMenu: async (m, menu) => {
      await ctx.reply(m, { reply_markup: toReplyKeyboard(menu), link_preview_options: { is_disabled: true } });
    },
  });

  const cb = (ctx: Context): CallbackCtx => ({
    tgId: ctx.from?.id ?? 0,
    data: ctx.callbackQuery?.data ?? "",
    answer: async (text) => {
      // Telegram requires an answerCallbackQuery within a few seconds or the
      // client shows a spinner forever. Swallow failures (a stale query throws
      // "query is too old") — the handler's work still completes.
      await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});
    },
    editText: async (m, kb) => {
      await ctx.editMessageText(m, {
        ...(kb ? { reply_markup: toInlineKeyboard(kb) } : {}),
        link_preview_options: { is_disabled: true },
      }).catch(async () => {
        // Edit can fail if the message is gone / unchanged; fall back to a
        // fresh message so the user still sees the update.
        await ctx.reply(m, {
          ...(kb ? { reply_markup: toInlineKeyboard(kb) } : {}),
          link_preview_options: { is_disabled: true },
        }).catch(() => {});
      });
    },
    reply: async (m, kb) => {
      await ctx.reply(m, {
        ...(kb ? { reply_markup: toInlineKeyboard(kb) } : {}),
        link_preview_options: { is_disabled: true },
      });
    },
  });

  // Wrap every command in auth + try/catch. A handler that throws (DB blip,
  // RPC timeout, SDK error) must NOT escape into grammy's middleware chain —
  // an uncaught throw there can stall the polling loop. We catch, log, and
  // reply a generic message so the bot stays alive for the next update.
  const handle = (
    name: string,
    fn: (ctx: CommandCtx) => Promise<void>,
  ) => async (ctx: Context): Promise<void> => {
    if (!auth(ctx)) return;
    try {
      await fn(cmd(ctx));
    } catch (e) {
      log.error({ cmd: name, tgId: ctx.from?.id, err: (e as Error).message }, "command handler threw");
      await ctx.reply("something went wrong — try again in a moment.").catch(() => {});
    }
  };

  // Same wrapper for callbackQuery handlers. The extra invariant: ALWAYS
  // answer the query, even on the error path — otherwise the tapped button
  // spins forever on the user's client. We answer in the catch (the happy
  // path answers inside the handler, where it can attach a toast).
  const onCallback = (
    name: string,
    fn: (ctx: CallbackCtx) => Promise<void>,
  ) => async (ctx: Context): Promise<void> => {
    if (!auth(ctx)) {
      await ctx.answerCallbackQuery({ text: "not authorized" }).catch(() => {});
      return;
    }
    try {
      await fn(cb(ctx));
    } catch (e) {
      log.error({ cb: name, tgId: ctx.from?.id, err: (e as Error).message }, "callback handler threw");
      await ctx.answerCallbackQuery({ text: "something went wrong — try again." }).catch(() => {});
      await ctx.reply("something went wrong — try again in a moment.").catch(() => {});
    }
  };

  bot.command(["start", "help"], handle("start", (c) => startHandler(deps, c)));
  bot.command("wallet",   handle("wallet",   (c) => showWallet(deps, c)));
  bot.command("balance",  handle("balance",  (c) => balanceHandler(deps, c)));
  bot.command("holdings", handle("holdings", (c) => showHoldings(deps, c)));
  bot.command("leader",   handle("leader",   (c) => showLeader(deps, c)));
  bot.command("discover", handle("discover", (c) => showDiscover(deps, c)));
  bot.command("cashout",  handle("cashout",  (c) => runCashout(deps, c)));
  bot.command("buy",      handle("buy",      (c) => runBuy(deps, deps.buy, flow, c)));
  bot.command("sell",     handle("sell",     (c) => runSell(deps, deps.sell, flow, c)));

  // Buy panel callbacks. Order: most-specific prefixes first so a regex can't
  // shadow a longer one (grammy matches in registration order).
  bot.callbackQuery("buy:cancel",                 onCallback("buy:cancel",      (c) => onBuyCancel(flow, c)));
  bot.callbackQuery("buy:confirm",                onCallback("buy:confirm",     (c) => onBuyConfirm(deps.buy, flow, c)));
  bot.callbackQuery(/^buy:notes:more:\d+$/,       onCallback("buy:notes:more",  (c) => onBuyNotesMore(deps.buy, flow, c)));
  bot.callbackQuery(/^buy:note:\d+$/,             onCallback("buy:note",        (c) => onBuyNote(deps.buy, flow, c)));
  bot.callbackQuery(/^buy:amt:\d+$/,              onCallback("buy:amt",         (c) => onBuyAmount(deps.buy, flow, c)));
  bot.callbackQuery(/^buy:tab:(notes|public)$/,   onCallback("buy:tab",         (c) => onBuyTab(deps.buy, flow, c)));

  // Sell panel callbacks.
  bot.callbackQuery("sell:cancel",                onCallback("sell:cancel",     (c) => onSellCancel(flow, c)));
  bot.callbackQuery("sell:confirm",               onCallback("sell:confirm",    (c) => onSellConfirm(deps.sell, flow, c)));
  bot.callbackQuery(/^sell:note:\d+$/,            onCallback("sell:note",       (c) => onSellNote(deps.sell, flow, c)));
  bot.callbackQuery(/^sell:mint:.+$/,             onCallback("sell:mint",       (c) => onSellMint(deps.sell, flow, c)));

  // Withdraw note-picker callbacks.
  bot.callbackQuery("wd:cancel",                  onCallback("wd:cancel",       (c) => onWithdrawCancel(flow, c)));
  bot.callbackQuery(/^wd:note:\d+$/,              onCallback("wd:note",         (c) => onWithdrawNote(deps, flow, c)));

  // ── Persistent-menu taps (bot.hears). A menu button sends its label as a
  // text message; we catch the label and route to the same panel the slash
  // command opens. Registered BEFORE the catch-all message:text handler so a
  // menu tap is consumed here and never falls through to the paste-CA router.
  bot.hears([MENU_BUY, "Buy"],           handle("menu-buy",      (c) => promptBuyCa(flow, c)));
  bot.hears([MENU_SELL, "Sell"],         handle("menu-sell",     (c) => openSellTokenList(deps.sell, c)));
  bot.hears([MENU_WALLET, "Wallet"],     handle("menu-wallet",   (c) => showWallet(deps, c)));
  bot.hears([MENU_WITHDRAW, "Withdraw"], handle("menu-withdraw", (c) => startWithdraw(deps, flow, c)));

  // ── Free-text router. Only plain text that wasn't a command or a menu label
  // reaches here. If the user just tapped Buy (awaitBuyCa), the next message is
  // their contract address. Otherwise we paste-anywhere: any message that
  // parses to a valid mint opens the buy panel; anything else is ignored
  // silently (no nagging on stray chatter).
  bot.on("message:text", async (ctx) => {
    if (!auth(ctx)) return;
    const tgId = ctx.from?.id ?? 0;
    // Withdraw-dest FIRST: a wallet address is base58 and would otherwise
    // parse as a token mint and wrongly open a buy panel.
    if (flow.awaitWithdrawDest.delete(tgId)) {
      try {
        await presentWithdrawNotes(deps, flow, cmd(ctx), ctx.message.text.trim());
      } catch (e) {
        log.error({ tgId, err: (e as Error).message }, "withdraw text router threw");
        await ctx.reply("something went wrong — try again in a moment.").catch(() => {});
      }
      return;
    }
    const awaiting = flow.awaitBuyCa.delete(tgId); // consume the flag if set
    try {
      const mint = parseMintFromInput(ctx.message.text);
      if (mint) {
        await openBuyPanel(deps.buy, flow, cmd(ctx), mint);
      } else if (awaiting) {
        await ctx.reply("couldn't read a contract address there — paste a Solana token mint or a Dexscreener/Birdeye link.");
      }
      // else: not awaiting + not a mint → ignore.
    } catch (e) {
      log.error({ tgId, err: (e as Error).message }, "text router threw");
      await ctx.reply("something went wrong — try again in a moment.").catch(() => {});
    }
  });

  // ── Receipt-chaining + Wallet inline buttons (menu:*). Let a user re-enter
  // the loop from a receipt without touching the menu bar. onMenu hands the
  // raw grammy ctx so the existing CommandCtx panels can be reused as-is.
  const onMenu = (
    name: string,
    fn: (ctx: Context) => Promise<void>,
  ) => async (ctx: Context): Promise<void> => {
    if (!auth(ctx)) {
      await ctx.answerCallbackQuery({ text: "not authorized" }).catch(() => {});
      return;
    }
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      await fn(ctx);
    } catch (e) {
      log.error({ cb: name, tgId: ctx.from?.id, err: (e as Error).message }, "menu callback threw");
      await ctx.reply("something went wrong — try again in a moment.").catch(() => {});
    }
  };
  bot.callbackQuery("menu:buy",      onMenu("menu:buy",      (ctx) => promptBuyCa(flow, cmd(ctx))));
  bot.callbackQuery("menu:holdings", onMenu("menu:holdings", (ctx) => showHoldings(deps, cmd(ctx))));
  bot.callbackQuery("menu:wallet",   onMenu("menu:wallet",   (ctx) => showWallet(deps, cmd(ctx))));
  bot.callbackQuery("menu:withdraw", onMenu("menu:withdraw", (ctx) => startWithdraw(deps, flow, cmd(ctx))));

  // Last-resort error boundary. Anything that still escapes lands here
  // instead of crashing the long-poll loop.
  bot.catch((err) => {
    log.error({ err: err.message, update: err.ctx?.update?.update_id }, "grammy uncaught");
  });
}

/** Shared "tap Buy → paste a CA" prompt. Sets the awaitBuyCa flag so the next
 *  plain-text message is treated as a contract address by the text router. */
async function promptBuyCa(flow: FlowState, ctx: CommandCtx): Promise<void> {
  flow.awaitBuyCa.add(ctx.tgId);
  const text = ["Buy a token", "", "Paste the contract address of any Solana token (or a Dexscreener / Birdeye link)."].join("\n");
  if (ctx.replyWithKeyboard) {
    await ctx.replyWithKeyboard(text, [[{ text: "Cancel", callbackData: "buy:cancel" }]]);
  } else {
    await ctx.reply(text);
  }
}

async function startHandler(deps: Deps, ctx: CommandCtx): Promise<void> {
  const pubkey = deps.resolvePubkey(ctx.tgId);
  await deps.pool.query(
    `INSERT INTO stealth.users (tg_id, solana_pubkey) VALUES ($1, $2)
     ON CONFLICT (tg_id) DO UPDATE SET solana_pubkey = EXCLUDED.solana_pubkey`,
    [ctx.tgId, pubkey],
  );
  const text = [
    "🔒 stealth-trader — private trading on Solana",
    "",
    "Send any amount of SOL to your deposit address:",
    pubkey,
    "",
    "Auto-credits ~10s after the deposit confirms — you'll get a DM when it lands.",
    "",
    "Then tap a button below to trade. No commands to memorize.",
  ].join("\n");
  // Dock the persistent Buy / Sell / Wallet / Withdraw menu. This is the
  // whole no-typing surface — it stays pinned at the bottom of the chat.
  if (ctx.replyWithMenu) {
    await ctx.replyWithMenu(text, MAIN_MENU);
  } else {
    await ctx.reply(text);
  }
}

async function balanceHandler(deps: Deps, ctx: CommandCtx): Promise<void> {
  // LIVE balances, like b402-trader: public from Solana RPC, private from the
  // SDK (indexer-backed holdings). Never the DB ledger — that can lag/drift.
  const WSOL = "So11111111111111111111111111111111111111112";
  const [publicLamports, shieldedSol] = await Promise.all([
    deps.publicNativeLamports ? deps.publicNativeLamports(ctx.tgId).catch(() => 0n) : Promise.resolve(0n),
    deps.wallet?.getNotes
      ? deps.wallet.getNotes(ctx.tgId, WSOL).then((ns) => ns.reduce((a, n) => a + n.amount, 0n)).catch(() => 0n)
      : Promise.resolve(0n),
  ]);
  const fmt = (l: bigint) => (Number(l) / Number(SOL)).toFixed(4);
  await ctx.reply(
    [
      `🔒 Private: ${fmt(shieldedSol)} SOL`,
      `🌐 Public:  ${fmt(publicLamports)} SOL`,
    ].join("\n"),
  );
}
