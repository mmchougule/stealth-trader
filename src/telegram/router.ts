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
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Deps, CommandCtx, CallbackCtx, Keyboard } from "./types.js";
import { log } from "../log.js";
import { showWallet } from "./panels/wallet.js";
import { showHoldings } from "./panels/holdings.js";
import { showLeader } from "./panels/leader.js";
import { showDiscover } from "./panels/discover.js";
import { runCashout } from "./panels/cashout.js";
import {
  runBuy, type BuyDeps,
  onBuyCancel, onBuyNote, onBuyAmount, onBuyTab, onBuyNotesMore, onBuyConfirm,
} from "./panels/buy.js";
import {
  runSell, type SellDeps,
  onSellMint, onSellNote, onSellCancel, onSellConfirm,
} from "./panels/sell.js";
import { makeFlowState } from "./state.js";

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

  // Last-resort error boundary. Anything that still escapes lands here
  // instead of crashing the long-poll loop.
  bot.catch((err) => {
    log.error({ err: err.message, update: err.ctx?.update?.update_id }, "grammy uncaught");
  });
}

async function startHandler(deps: Deps, ctx: CommandCtx): Promise<void> {
  const pubkey = deps.resolvePubkey(ctx.tgId);
  await deps.pool.query(
    `INSERT INTO stealth.users (tg_id, solana_pubkey) VALUES ($1, $2)
     ON CONFLICT (tg_id) DO UPDATE SET solana_pubkey = EXCLUDED.solana_pubkey`,
    [ctx.tgId, pubkey],
  );
  await ctx.reply(
    [
      "stealth-trader is ready.",
      "",
      "your deposit address:",
      pubkey,
      "",
      "send SOL there, then:",
      "  /balance                 show your SOL",
      "  /buy <mint>              open the buy panel (tap to trade)",
      "  /buy <mint> <sol>        one-shot buy",
      "  /sell                    pick a token to sell",
      "  /sell <mint> <amount>    one-shot sell",
      "  /holdings                shielded balances + sell buttons",
      "  /leader <wallet>         7-day stats for a wallet",
      "  /discover                curated leaders",
      "  /cashout <recipient>     unshield to any address",
      "  /wallet                  show deposit address",
    ].join("\n"),
  );
}

async function balanceHandler(deps: Deps, ctx: CommandCtx): Promise<void> {
  const r = await deps.pool.query(
    `SELECT sol_balance_lamports FROM stealth.users WHERE tg_id = $1`,
    [ctx.tgId],
  );
  const lamports = r.rowCount && r.rowCount > 0 ? BigInt(r.rows[0].sol_balance_lamports) : 0n;
  const sol = (Number(lamports) / Number(SOL)).toFixed(4);
  await ctx.reply(`${sol} SOL  (${lamports.toString()} lamports)`);
}
