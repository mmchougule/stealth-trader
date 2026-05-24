/**
 * MCP tool handlers. Each handler:
 *   - validates input via the zod schema
 *   - performs the same operation the Telegram command does
 *   - returns a structured-text response the LLM can compose on
 *
 * Handlers are PURE FUNCTIONS over their deps. The MCP server (index.ts)
 * supplies the deps; tests construct a stub deps object and call
 * handlers directly. This is the same separation as src/telegram.ts.
 *
 * Every handler returns `{ content: [{ type: "text", text: ... }] }`,
 * which is the MCP response shape. The text is what the LLM sees.
 */
import type { Pool } from "pg";
import {
  followInput, unfollowInput, getWalletInput, getBalanceInput,
  listFollowsInput, privateBuyInput, cashoutInput, getHoldingsInput,
  discoverLeadersInput,
} from "./schemas.js";

const SOL = 1_000_000_000n;

export interface McpDeps {
  pool: Pool;
  /** The Telegram user this MCP instance acts on behalf of. */
  tgId: number;
  resolvePubkey(tgId: number): string;
  /** Execute a buy through the b402 SDK. */
  trade: {
    executeBuy(args: { tgId: number; mint: string; solLamports: bigint }): Promise<
      | { ok: true; txSignature: string; tokensReceived: bigint }
      | { ok: false; error: string }
    >;
  };
  /** Optional unshield (v0.3 stub returns "not implemented"). */
  cashout?: (args: { tgId: number; recipient: string; lamports: bigint }) => Promise<{ ok: true; txSignature: string } | { ok: false; error: string }>;
  /** Optional leader scoring. */
  discover?: (args: { candidates: string[]; lookbackHours: number }) => Promise<Array<{ wallet: string; score: number; buys: number; pnlSol: number }>>;
}

type Mcp = { content: Array<{ type: "text"; text: string }> };

const ok = (text: string): Mcp => ({ content: [{ type: "text", text }] });

export const handlers = {
  async get_wallet(_: unknown, d: McpDeps): Promise<Mcp> {
    getWalletInput.parse(_);
    const pubkey = d.resolvePubkey(d.tgId);
    await d.pool.query(
      `INSERT INTO stealth.users (tg_id, solana_pubkey) VALUES ($1, $2)
       ON CONFLICT (tg_id) DO UPDATE SET solana_pubkey = EXCLUDED.solana_pubkey`,
      [d.tgId, pubkey],
    );
    return ok(`deposit address: ${pubkey}\nsend SOL here to fund the bot.`);
  },

  async get_balance(_: unknown, d: McpDeps): Promise<Mcp> {
    getBalanceInput.parse(_);
    const r = await d.pool.query(
      `SELECT sol_balance_lamports FROM stealth.users WHERE tg_id = $1`,
      [d.tgId],
    );
    const lamports = r.rowCount && r.rowCount > 0 ? BigInt(r.rows[0].sol_balance_lamports) : 0n;
    return ok(`${(Number(lamports) / Number(SOL)).toFixed(4)} SOL (${lamports.toString()} lamports)`);
  },

  async get_holdings(_: unknown, d: McpDeps): Promise<Mcp> {
    getHoldingsInput.parse(_);
    // Shielded holdings come from the SDK NoteStore, which we don't fan
    // out per-MCP-call yet — wired in v0.4. For now, surface the public
    // balance so the agent has SOMETHING to compose on.
    const r = await d.pool.query(
      `SELECT sol_balance_lamports FROM stealth.users WHERE tg_id = $1`,
      [d.tgId],
    );
    const lamports = r.rowCount && r.rowCount > 0 ? BigInt(r.rows[0].sol_balance_lamports) : 0n;
    return ok(`(v0.3) shielded-token holdings view ships in v0.4. public SOL: ${(Number(lamports) / Number(SOL)).toFixed(4)} SOL.`);
  },

  async follow(args: unknown, d: McpDeps): Promise<Mcp> {
    const parsed = followInput.parse(args);
    const perTrade = BigInt(Math.round(parsed.sol_per_trade * 1e9));
    const dailyBudget = parsed.daily_budget_sol
      ? BigInt(Math.round(parsed.daily_budget_sol * 1e9))
      : perTrade * 10n;
    await d.pool.query(
      `INSERT INTO stealth.users (tg_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [d.tgId],
    );
    const r = await d.pool.query(
      `INSERT INTO stealth.follows
         (follower_tg, leader_wallet, per_trade_lamports, daily_budget_lamports, active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (follower_tg, leader_wallet) DO UPDATE
         SET per_trade_lamports    = EXCLUDED.per_trade_lamports,
             daily_budget_lamports = EXCLUDED.daily_budget_lamports,
             active                = TRUE
       RETURNING id`,
      [d.tgId, parsed.leader_wallet, perTrade.toString(), dailyBudget.toString()],
    );
    return ok(`following ${parsed.leader_wallet} at ${parsed.sol_per_trade} SOL/trade (id=${r.rows[0].id}).`);
  },

  async unfollow(args: unknown, d: McpDeps): Promise<Mcp> {
    const parsed = unfollowInput.parse(args);
    const r = await d.pool.query(
      `UPDATE stealth.follows SET active = FALSE
       WHERE follower_tg = $1 AND leader_wallet = $2 AND active = TRUE
       RETURNING id`,
      [d.tgId, parsed.leader_wallet],
    );
    if (r.rowCount === 0) return ok(`no active follow for ${parsed.leader_wallet}.`);
    return ok(`unfollowed ${parsed.leader_wallet}.`);
  },

  async list_follows(_: unknown, d: McpDeps): Promise<Mcp> {
    listFollowsInput.parse(_);
    const r = await d.pool.query(
      `SELECT leader_wallet, per_trade_lamports, daily_budget_lamports, active
       FROM stealth.follows WHERE follower_tg = $1 ORDER BY id`,
      [d.tgId],
    );
    if (r.rowCount === 0) return ok("no active follows.");
    const lines = r.rows.map((row) => {
      const status = row.active ? "active" : "paused";
      const sol = (Number(row.per_trade_lamports) / Number(SOL)).toFixed(4);
      return `${row.leader_wallet}  ${sol} SOL/trade  ${status}`;
    });
    return ok(lines.join("\n"));
  },

  async private_buy(args: unknown, d: McpDeps): Promise<Mcp> {
    const parsed = privateBuyInput.parse(args);
    const lamports = BigInt(Math.round(parsed.sol * 1e9));
    const res = await d.trade.executeBuy({ tgId: d.tgId, mint: parsed.mint, solLamports: lamports });
    if (!res.ok) return ok(`buy failed: ${res.error}`);
    return ok(`bought ${parsed.mint.slice(0, 8)}… for ${parsed.sol} SOL\nsig: ${res.txSignature}\nshielded note received: ${res.tokensReceived.toString()} raw units`);
  },

  async cashout(args: unknown, d: McpDeps): Promise<Mcp> {
    const parsed = cashoutInput.parse(args);
    if (!d.cashout) return ok("cashout not configured on this MCP server.");
    const lamports = BigInt(Math.round(parsed.sol * 1e9));
    const res = await d.cashout({ tgId: d.tgId, recipient: parsed.recipient, lamports });
    if (!res.ok) return ok(`cashout failed: ${res.error}`);
    return ok(`unshielded ${parsed.sol} SOL to ${parsed.recipient}\nsig: ${res.txSignature}\nno on-chain link to your deposit address.`);
  },

  async discover_leaders(args: unknown, d: McpDeps): Promise<Mcp> {
    const parsed = discoverLeadersInput.parse(args);
    if (!d.discover) return ok("leader discovery not configured on this MCP server.");
    const scored = await d.discover({ candidates: parsed.candidates, lookbackHours: parsed.lookback_hours });
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const lines = sorted.map((s, i) =>
      `${i + 1}. ${s.wallet}  buys=${s.buys}  PnL=${s.pnlSol.toFixed(3)} SOL  score=${s.score.toFixed(2)}`,
    );
    return ok(lines.length ? lines.join("\n") : "no scoring data for those wallets.");
  },
};
