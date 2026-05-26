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

  bot.command(["start", "help"], async (ctx) => {
    if (!auth(ctx)) return;
    await startHandler(deps, cmd(ctx));
  });
  bot.command("wallet",   async (ctx) => { if (auth(ctx)) await showWallet(deps, cmd(ctx)); });
  bot.command("balance",  async (ctx) => { if (auth(ctx)) await balanceHandler(deps, cmd(ctx)); });
  bot.command("holdings", async (ctx) => { if (auth(ctx)) await showHoldings(deps, cmd(ctx)); });
  bot.command("leader",   async (ctx) => { if (auth(ctx)) await showLeader(deps, cmd(ctx)); });
  bot.command("discover", async (ctx) => { if (auth(ctx)) await showDiscover(deps, cmd(ctx)); });
  bot.command("cashout",  async (ctx) => { if (auth(ctx)) await runCashout(deps, cmd(ctx)); });
  bot.command("buy",      async (ctx) => { if (auth(ctx)) await runBuy(deps, deps.buy, cmd(ctx)); });
  bot.command("sell",     async (ctx) => { if (auth(ctx)) await runSell(deps, deps.sell, cmd(ctx)); });
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
