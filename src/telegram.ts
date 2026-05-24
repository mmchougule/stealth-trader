/**
 * Telegram bot UI.
 *
 * Command surface (v0.1):
 *   /start                — welcome message + command list
 *   /follow WALLET SOL    — start copying a leader at SOL per trade
 *   /follows              — list active follows
 *   /unfollow WALLET      — stop copying a leader
 *   /help                 — same as /start
 *
 * No emoji, no inline keyboards yet — those land in v0.2 once the basic
 * flow is solid. The auth check (`AUTHORIZED_TG_USERS`) is applied as a
 * middleware so unauthorised users get one rejection and nothing else.
 *
 * Tests inject a fake `Bot`-like object and exercise the handlers directly.
 * The grammy framework is wired in `bot.ts`, not here, to keep this module
 * testable without booting a real Telegram connection.
 */
import type { DbPool } from "./db/index.js";

const SOL = 1_000_000_000n; // lamports per SOL

export interface CommandCtx {
  tgId: number;
  text: string;
  reply(message: string): Promise<void>;
}

export interface TelegramDeps {
  pool: DbPool;
  authorizedTgUsers: ReadonlySet<number>;
  /** Returns the user's derived Solana public address (base58). Injected
   *  so tests don't need to import the wallet derivation chain. */
  resolvePubkey(tgId: number): string;
  /** Wallet backend — only used by /holdings and /cashout. Optional so
   *  tests can omit it for non-wallet command coverage. */
  wallet?: {
    getHoldings(tgId: number): Promise<Array<{ mint: string; amount: string; decimals: number }>>;
    cashout(args: { tgId: number; recipient: string; mint?: string }): Promise<{ txSignature: string }>;
  };
}

export function makeTelegramHandlers(deps: TelegramDeps) {
  return {
    async start(ctx: CommandCtx) {
      if (!check(deps, ctx)) return;
      // Ensure user row exists and we know their derived pubkey.
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
          `your deposit address:`,
          pubkey,
          "",
          `send SOL there, then:`,
          `  /balance                  show your SOL`,
          `  /follow <wallet> <sol>    start copying a leader`,
          `  /follows                  list active follows`,
          `  /unfollow <wallet>        stop copying a leader`,
          `  /holdings                 show shielded tokens`,
          `  /wallet                   show your deposit address`,
        ].join("\n"),
      );
    },

    async wallet(ctx: CommandCtx) {
      if (!check(deps, ctx)) return;
      await ctx.reply(deps.resolvePubkey(ctx.tgId));
    },

    async balance(ctx: CommandCtx) {
      if (!check(deps, ctx)) return;
      const r = await deps.pool.query(
        `SELECT sol_balance_lamports FROM stealth.users WHERE tg_id = $1`,
        [ctx.tgId],
      );
      const lamports = r.rowCount && r.rowCount > 0 ? BigInt(r.rows[0].sol_balance_lamports) : 0n;
      const sol = (Number(lamports) / Number(SOL)).toFixed(4);
      await ctx.reply(`${sol} SOL  (${lamports.toString()} lamports)`);
    },

    async holdings(ctx: CommandCtx) {
      if (!check(deps, ctx)) return;
      if (!deps.wallet) {
        await ctx.reply("wallet backend not configured on this instance.");
        return;
      }
      try {
        const rows = await deps.wallet.getHoldings(ctx.tgId);
        if (rows.length === 0) {
          await ctx.reply("no shielded holdings.");
          return;
        }
        const lines = rows.map((h) => {
          const amt = formatAmount(h.amount, h.decimals);
          return `${truncWallet(h.mint)}  ${amt}`;
        });
        await ctx.reply(lines.join("\n"));
      } catch (e) {
        await ctx.reply(`holdings failed: ${(e as Error).message}`);
      }
    },

    async follow(ctx: CommandCtx) {
      if (!check(deps, ctx)) return;
      const args = parseArgs(ctx.text);
      if (args.length !== 2) {
        await ctx.reply("usage: /follow <wallet> <sol-per-trade>");
        return;
      }
      const [wallet, solStr] = args;
      const lamports = parseSolAmount(solStr);
      if (lamports === null) {
        await ctx.reply("invalid SOL amount. example: /follow ABC...XYZ 0.005");
        return;
      }
      if (lamports < SOL / 1000n) {
        await ctx.reply(`minimum per-trade size is 0.001 SOL`);
        return;
      }
      // ensure user row exists
      await deps.pool.query(
        `INSERT INTO stealth.users (tg_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [ctx.tgId],
      );
      const r = await deps.pool.query(
        `INSERT INTO stealth.follows
           (follower_tg, leader_wallet, per_trade_lamports, daily_budget_lamports, active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (follower_tg, leader_wallet) DO UPDATE
           SET per_trade_lamports    = EXCLUDED.per_trade_lamports,
               daily_budget_lamports = EXCLUDED.daily_budget_lamports,
               active                = TRUE
         RETURNING id`,
        [ctx.tgId, wallet, lamports.toString(), (lamports * 10n).toString()],
      );
      await ctx.reply(
        `following ${truncWallet(wallet)} at ${solStr} SOL per trade (id=${r.rows[0].id}). daily cap: ${(Number(lamports * 10n) / Number(SOL)).toFixed(3)} SOL.`,
      );
    },

    async follows(ctx: CommandCtx) {
      if (!check(deps, ctx)) return;
      const r = await deps.pool.query(
        `SELECT leader_wallet, per_trade_lamports, daily_budget_lamports, active
         FROM stealth.follows WHERE follower_tg = $1 ORDER BY id`,
        [ctx.tgId],
      );
      if (r.rowCount === 0) {
        await ctx.reply("no active follows. start one with /follow <wallet> <sol>.");
        return;
      }
      const lines = r.rows.map((row) => {
        const status = row.active ? "active" : "paused";
        const sol = (Number(row.per_trade_lamports) / Number(SOL)).toFixed(3);
        return `${truncWallet(row.leader_wallet)}  ${sol} SOL/trade  ${status}`;
      });
      await ctx.reply(lines.join("\n"));
    },

    async cashout(ctx: CommandCtx) {
      if (!check(deps, ctx)) return;
      if (!deps.wallet) {
        await ctx.reply("wallet backend not configured on this instance.");
        return;
      }
      const args = parseArgs(ctx.text);
      // /cashout <recipient>          (unshields the user's largest wSOL note)
      // /cashout <recipient> <mint>   (unshields the user's largest note of <mint>)
      if (args.length < 1 || args.length > 2) {
        await ctx.reply("usage: /cashout <recipient-wallet> [mint]");
        return;
      }
      const [recipient, mint] = args;
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(recipient)) {
        await ctx.reply("invalid recipient — must be a base58 Solana address.");
        return;
      }
      try {
        const res = await deps.wallet.cashout({ tgId: ctx.tgId, recipient, ...(mint ? { mint } : {}) });
        await ctx.reply(`unshielded to ${truncWallet(recipient)}\nsig: ${res.txSignature}\nno on-chain link to your deposit address.`);
      } catch (e) {
        await ctx.reply(`cashout failed: ${(e as Error).message}`);
      }
    },

    async unfollow(ctx: CommandCtx) {
      if (!check(deps, ctx)) return;
      const args = parseArgs(ctx.text);
      if (args.length !== 1) {
        await ctx.reply("usage: /unfollow <wallet>");
        return;
      }
      const r = await deps.pool.query(
        `UPDATE stealth.follows SET active = FALSE
         WHERE follower_tg = $1 AND leader_wallet = $2 AND active = TRUE
         RETURNING id`,
        [ctx.tgId, args[0]],
      );
      if (r.rowCount === 0) {
        await ctx.reply(`no active follow for ${truncWallet(args[0])}.`);
        return;
      }
      await ctx.reply(`stopped copying ${truncWallet(args[0])}.`);
    },
  };
}

function check(deps: TelegramDeps, ctx: CommandCtx): boolean {
  if (deps.authorizedTgUsers.has(ctx.tgId)) return true;
  // Reply once, then bail. Don't expose authorization details.
  void ctx.reply("not authorized");
  return false;
}

function parseArgs(text: string): string[] {
  const parts = text.trim().split(/\s+/);
  // drop the leading /command token
  return parts.slice(1);
}

function parseSolAmount(s: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, frac = ""] = s.split(".");
  const padded = (frac + "000000000").slice(0, 9); // 9 decimals
  try {
    return BigInt(intPart) * SOL + BigInt(padded);
  } catch {
    return null;
  }
}

function truncWallet(w: string): string {
  if (w.length <= 12) return w;
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

function formatAmount(rawAmount: string, decimals: number): string {
  if (decimals === 0) return rawAmount;
  const padded = rawAmount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
