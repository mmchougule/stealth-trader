/**
 * Bot entrypoint. Wires:
 *   - Postgres pool
 *   - grammy Telegram bot (commands → telegram.ts handlers)
 *   - HTTP webhook server (Helius → webhook-handler.ts)
 *   - reconcileWebhook on boot (single-webhook architecture)
 *
 * The trade backend is deliberately stubbed (`stubSwapBackend`) for v0.1:
 * the SDK integration lands in v0.2 once the orchestration scaffold is
 * battle-tested. The bot is a real, runnable end-to-end shell — you can
 * /follow, /unfollow, see logs, observe webhook receipts — without any
 * real SOL leaving an account yet. This lets us prove the public API
 * surface before threading live funds through.
 */
import "dotenv/config";
import http from "node:http";
import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { getPool } from "./db/index.js";
import { makeTelegramHandlers, type CommandCtx } from "./telegram.js";
import { handleWebhook } from "./copy-trade/webhook-handler.js";
import { reconcileWebhook } from "./copy-trade/helius-webhook.js";
import { makeFollowStore } from "./follows.js";

async function main() {
  const cfg = loadConfig();
  log.info({ cluster: cfg.cluster }, "stealth-trader starting");

  const pool = getPool();
  const handlers = makeTelegramHandlers({
    pool,
    authorizedTgUsers: cfg.authorizedTgUsers,
  });
  const follows = makeFollowStore(pool);

  // Telegram bot.
  const bot = new Bot(cfg.telegramBotToken);
  bot.command("start", (c) => handlers.start(toCmdCtx(c)));
  bot.command("help", (c) => handlers.start(toCmdCtx(c)));
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
        trade: stubSwapBackend(),
        ...(process.env.DUST_MIN_LAMPORTS !== undefined ? { envDustMin: process.env.DUST_MIN_LAMPORTS } : {}),
      },
    );
    res.writeHead(out.status, { "Content-Type": "application/json" }).end(JSON.stringify(out.body));
  });
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => log.info({ port }, "webhook server listening"));

  // Reconcile Helius webhook against current follows (best-effort; the
  // bot will still come up if Helius is unreachable — copies just won't
  // fire until reconciliation succeeds on a later trigger).
  if (cfg.webhookPublicUrl) {
    try {
      const heliusKey = extractApiKey(cfg.heliusRpcUrl);
      const r = await pool.query(
        `SELECT DISTINCT leader_wallet FROM stealth.follows WHERE active`,
      );
      const addresses = r.rows.map((row): string => row.leader_wallet);
      if (addresses.length > 0) {
        const w = await reconcileWebhook({
          apiKey: heliusKey,
          publicUrl: `${cfg.webhookPublicUrl.replace(/\/$/, "")}/webhook/helius`,
          authHeader: cfg.heliusWebhookSecret,
          addresses,
          pool,
        });
        log.info({ id: w.webhookID, n: addresses.length }, "helius webhook reconciled");
      } else {
        log.info({}, "no active follows yet — webhook will be created on first /follow");
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "helius reconcile failed; continuing");
    }
  }

  await bot.start();
}

function toCmdCtx(c: { from?: { id: number }; message?: { text?: string }; reply: (m: string) => Promise<unknown> }): CommandCtx {
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

function stubSwapBackend() {
  return {
    async executeBuy(args: { tgId: number; mint: string; solLamports: bigint }) {
      log.info({ ...args, solLamports: args.solLamports.toString() }, "stub swap backend invoked");
      return { ok: false as const, error: "swap backend not configured in v0.1 stub" };
    },
  };
}

main().catch((e) => {
  log.error({ err: (e as Error).message }, "fatal");
  process.exit(1);
});
