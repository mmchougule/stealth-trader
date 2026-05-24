/**
 * Bot entrypoint. v0.2: real SDK-backed swap path + deposit watcher.
 *
 * Boot order:
 *   1. Load + validate env (config.ts).
 *   2. Open Postgres pool.
 *   3. Build the SwapBackend (b402-backend.ts) — one SDK per Telegram
 *      user, lazy + cached.
 *   4. Build the BalanceStore + makeTrade(trade.ts) — wraps backend
 *      in debit-before-send + refund-on-failure.
 *   5. Build the Telegram bot (grammy) with command handlers.
 *   6. Boot the HTTP webhook server (handles Helius POSTs).
 *   7. Reconcile the Helius webhook (single-webhook architecture).
 *   8. Start the deposit watcher loop (crediting incoming SOL to
 *      stealth.users.sol_balance_lamports).
 *   9. bot.start() — long-poll Telegram updates.
 *
 * Everything below the top-level imports is straight-line wiring with
 * no policy decisions. The decisions live in the modules under test.
 */
import "dotenv/config";
import http from "node:http";
import { Connection, PublicKey } from "@solana/web3.js";
import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { getPool } from "./db/index.js";
import { parseMasterSeed } from "./wallet.js";
import { makeB402Backend, userPubkey, makeConnection } from "./b402-backend.js";
import { makeBalanceStore } from "./balance.js";
import { makeTrade } from "./trade.js";
import { makeFollowStore } from "./follows.js";
import { makeTelegramHandlers, type CommandCtx } from "./telegram.js";
import { handleWebhook } from "./copy-trade/webhook-handler.js";
import { reconcileWebhook } from "./copy-trade/helius-webhook.js";
import { extractDeposits, readCursor, writeCursor } from "./deposits.js";

async function main() {
  const cfg = loadConfig();
  log.info({ cluster: cfg.cluster }, "stealth-trader starting");

  const pool = getPool();
  const masterSeed = parseMasterSeed(cfg.masterSeedHex);
  const resolvePubkey = (tgId: number): string => userPubkey(tgId, masterSeed);

  // Backend + trade pipeline.
  const backend = makeB402Backend({
    masterSeed,
    rpcUrl: cfg.heliusRpcUrl,
    cluster: cfg.cluster,
    ...(cfg.relayerUrl ? { relayerUrl: cfg.relayerUrl } : {}),
  });
  const balance = makeBalanceStore(pool);
  const trade = makeTrade({ backend, balance });

  const handlers = makeTelegramHandlers({
    pool,
    authorizedTgUsers: cfg.authorizedTgUsers,
    resolvePubkey,
  });
  const follows = makeFollowStore(pool);

  // Telegram bot.
  const bot = new Bot(cfg.telegramBotToken);
  bot.command("start", (c) => handlers.start(toCmdCtx(c)));
  bot.command("help", (c) => handlers.start(toCmdCtx(c)));
  bot.command("wallet", (c) => handlers.wallet(toCmdCtx(c)));
  bot.command("balance", (c) => handlers.balance(toCmdCtx(c)));
  bot.command("holdings", (c) => handlers.holdings(toCmdCtx(c)));
  bot.command("follow", (c) => handlers.follow(toCmdCtx(c)));
  bot.command("follows", (c) => handlers.follows(toCmdCtx(c)));
  bot.command("unfollow", (c) => handlers.unfollow(toCmdCtx(c)));

  // HTTP webhook receiver.
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook/helius") {
      res.writeHead(404).end();
      return;
    }
    const body = await readJson(req).catch(() => null);
    const out = await handleWebhook(
      { headers: req.headers, body },
      {
        authSecret: cfg.heliusWebhookSecret,
        follows,
        trade,
        ...(process.env.DUST_MIN_LAMPORTS !== undefined ? { envDustMin: process.env.DUST_MIN_LAMPORTS } : {}),
      },
    );
    res.writeHead(out.status, { "Content-Type": "application/json" }).end(JSON.stringify(out.body));

    // DM each successful copy back to the follower. Best-effort — a
    // Telegram failure must not block the webhook response.
    for (const o of out.body.outcomes ?? []) {
      if (o.status !== "success") continue;
      const r = await pool.query(
        `SELECT follower_tg FROM stealth.follows WHERE id = $1`,
        [o.followId],
      );
      const tg = r.rowCount && r.rowCount > 0 ? Number(r.rows[0].follower_tg) : null;
      if (tg) {
        await bot.api.sendMessage(tg,
          `copied ${o.mint.slice(0, 8)}… for ${(Number(o.amountLamports) / 1e9).toFixed(4)} SOL\n${o.followerSig ?? ""}`,
        ).catch((e: unknown) => log.warn({ err: (e as Error).message }, "DM send failed"));
      }
    }
  });
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => log.info({ port }, "webhook server listening"));

  // Reconcile Helius webhook against active follows.
  if (cfg.webhookPublicUrl) {
    try {
      const r = await pool.query(
        `SELECT DISTINCT leader_wallet FROM stealth.follows WHERE active`,
      );
      const addresses = r.rows.map((row): string => row.leader_wallet);
      if (addresses.length > 0) {
        const w = await reconcileWebhook({
          apiKey: extractApiKey(cfg.heliusRpcUrl),
          publicUrl: `${cfg.webhookPublicUrl.replace(/\/$/, "")}/webhook/helius`,
          authHeader: cfg.heliusWebhookSecret,
          addresses,
          pool,
        });
        log.info({ id: w.webhookID, n: addresses.length }, "helius webhook reconciled");
      } else {
        log.info({}, "no active follows yet — webhook reconcile deferred");
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "helius reconcile failed; continuing");
    }
  }

  // Deposit watcher. Polls Helius's per-address history endpoint every
  // 10s, credits new inbound SOL transfers to the user's balance.
  const conn = makeConnection(cfg.heliusRpcUrl);
  const heliusKey = extractApiKey(cfg.heliusRpcUrl);
  startDepositWatcher({ pool, balance, resolvePubkey, conn, heliusKey });

  await bot.start();
}

function toCmdCtx(c: {
  from?: { id: number };
  message?: { text?: string };
  reply: (m: string) => Promise<unknown>;
}): CommandCtx {
  return {
    tgId: c.from?.id ?? 0,
    text: c.message?.text ?? "",
    reply: async (m) => { await c.reply(m); },
  };
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function extractApiKey(rpcUrl: string): string {
  const m = /[?&]api-key=([^&]+)/.exec(rpcUrl);
  if (!m) throw new Error("HELIUS_RPC_URL is missing the api-key query parameter");
  return m[1];
}

interface DepositWatcherDeps {
  pool: ReturnType<typeof getPool>;
  balance: ReturnType<typeof makeBalanceStore>;
  resolvePubkey: (tgId: number) => string;
  conn: Connection;
  heliusKey: string;
  /** Visible for tests, default 10s. */
  intervalMs?: number;
}

function startDepositWatcher(deps: DepositWatcherDeps) {
  const interval = deps.intervalMs ?? 10_000;
  // eslint-disable-next-line no-console
  const tick = async () => {
    try {
      const users = await deps.pool.query(
        `SELECT tg_id FROM stealth.users WHERE solana_pubkey IS NOT NULL`,
      );
      for (const row of users.rows) {
        const tgId = Number(row.tg_id);
        await tickOneUser(tgId, deps).catch((e) =>
          log.warn({ err: (e as Error).message, tgId }, "deposit watcher tick failed"),
        );
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "deposit watcher outer failure");
    } finally {
      setTimeout(tick, interval).unref();
    }
  };
  setTimeout(tick, interval).unref();
}

async function tickOneUser(tgId: number, deps: DepositWatcherDeps): Promise<void> {
  const pubkey = deps.resolvePubkey(tgId);
  const sinceSlot = await readCursor(deps.pool, tgId);
  // Helius per-address tx history endpoint — paginates by `before`.
  // We pull at most 50 most-recent per tick; anything older is already
  // covered by the cursor on next tick.
  const url = `https://api.helius.xyz/v0/addresses/${pubkey}/transactions?api-key=${deps.heliusKey}&limit=50`;
  const r = await fetch(url);
  if (!r.ok) return;
  const txs = (await r.json()) as Array<{ signature: string; slot: number; nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }> }>;
  const deposits = extractDeposits(txs, pubkey, sinceSlot);
  if (deposits.length === 0) return;
  for (const d of deposits) {
    await deps.balance.credit(tgId, d.lamports, "deposit", d.signature);
    log.info({ tgId, lamports: d.lamports.toString(), sig: d.signature.slice(0, 8) }, "credited deposit");
  }
  const maxSlot = deposits.reduce((m, d) => (d.slot > m ? d.slot : m), sinceSlot);
  await writeCursor(deps.pool, tgId, maxSlot);
}

// Silences the unused-import warning when Connection / PublicKey shift.
void Connection; void PublicKey;

main().catch((e) => {
  log.error({ err: (e as Error).message }, "fatal");
  process.exit(1);
});
