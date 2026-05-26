/**
 * Telegram command router. Wires grammy's Bot instance to the per-panel
 * handlers. The router owns:
 *
 *   - the authorization middleware (deny anyone not in authorizedTgUsers)
 *   - the /start + /help home message
 *   - the /balance command (DB-backed, kept simple for v0.5)
 *   - delegation to panels/* for everything else
 *
 * Future state-machine work (Buy wizard, Sell wizard, /cashout flow)
 * also plugs in here — adding a new panel = (a) new file under panels/,
 * (b) one new wire-up line in registerHandlers.
 */
import { Bot, type Context } from "grammy";
import type { Deps, CommandCtx } from "./types.js";
import { log } from "../log.js";
import { showWallet } from "./panels/wallet.js";
import { showHoldings } from "./panels/holdings.js";
import { showLeader } from "./panels/leader.js";
import { showDiscover } from "./panels/discover.js";
import { runCashout } from "./panels/cashout.js";
import { runBuy, type BuyDeps } from "./panels/buy.js";
import { runSell, type SellDeps } from "./panels/sell.js";

const SOL = 1_000_000_000n;

export interface RouterDeps extends Deps {
  buy: BuyDeps;
  sell: SellDeps;
}

export function registerHandlers(bot: Bot, deps: RouterDeps): void {
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

  bot.command(["start", "help"], handle("start", (c) => startHandler(deps, c)));
  bot.command("wallet",   handle("wallet",   (c) => showWallet(deps, c)));
  bot.command("balance",  handle("balance",  (c) => balanceHandler(deps, c)));
  bot.command("holdings", handle("holdings", (c) => showHoldings(deps, c)));
  bot.command("leader",   handle("leader",   (c) => showLeader(deps, c)));
  bot.command("discover", handle("discover", (c) => showDiscover(deps, c)));
  bot.command("cashout",  handle("cashout",  (c) => runCashout(deps, c)));
  bot.command("buy",      handle("buy",      (c) => runBuy(deps, deps.buy, c)));
  bot.command("sell",     handle("sell",     (c) => runSell(deps, deps.sell, c)));

  // Last-resort error boundary. Anything that still escapes (callback query
  // handlers registered inside panels, middleware) lands here instead of
  // crashing the long-poll loop.
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
      "  /buy <mint> <sol>        private buy",
      "  /sell <mint> <amount>    private sell (v0.6)",
      "  /holdings                shielded balances",
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
