/**
 * Telegram bot entrypoint.
 *
 * v0.5 scope:
 *   - /start, /help        — welcome + main menu
 *   - /wallet              — your derived deposit address
 *   - /balance             — public SOL balance the bot can spend
 *   - /buy <mint>          — open the Buy panel
 *   - /sell <mint>         — open the Sell panel
 *   - /holdings            — shielded balances per mint
 *   - /cashout <recipient> — unshield to any address
 *
 * Out of scope for v1 (v0.6+): /follow, /follows, /unfollow, /leader,
 * /discover. Copy-trade lands once we have a hosted Helius webhook proxy
 * so end-users don't need ngrok.
 *
 * Deposit watcher: delta-balance polling (deposits.ts). Pings each user's
 * derived address every 10s via getMultipleAccountsInfo and credits the
 * on-chain delta. Naturally idempotent. Replaces the prior Helius-tx-
 * history approach which double-counted.
 */
import "dotenv/config";
import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
import { Bot } from "grammy";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { getPool, applySchema } from "./db/index.js";
import { parseMasterSeed } from "./wallet.js";
import { makeB402Backend, userPubkey, makeConnection } from "./b402-backend.js";
import { makeBalanceStore } from "./balance.js";
import { makeTrade } from "./trade.js";
import { makeTelegramHandlers, type CommandCtx } from "./telegram.js";
import { startDepositWatcher } from "./deposits.js";

/** Load a Solana CLI-format keypair JSON file (array of 64 bytes). */
function loadSolanaKeypairFile(p: string): Keypair {
  const expanded = p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p;
  const raw = JSON.parse(fs.readFileSync(expanded, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info({ cluster: cfg.cluster }, "stealth-trader starting");

  const pool = await getPool();
  // Auto-apply sql/001..004 on every boot. CREATE … IF NOT EXISTS + ALTER
  // ADD COLUMN IF NOT EXISTS everywhere — re-running is a no-op.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sqlDir = path.resolve(here, "..", "sql");
  await applySchema(pool, sqlDir);

  const masterSeed = parseMasterSeed(cfg.masterSeedHex);
  const resolvePubkey = (tgId: number): string => userPubkey(tgId, masterSeed);

  // Optional operator keypair that pays one-time recipient ATA rent in
  // /cashout. Loaded from OPERATOR_FEE_KEYPAIR_PATH. Without it, fresh-
  // recipient cashouts only work if the user's derived keypair has spare SOL.
  const operatorFeeKeypair = cfg.operatorFeeKeypairPath
    ? loadSolanaKeypairFile(cfg.operatorFeeKeypairPath)
    : undefined;
  if (operatorFeeKeypair) {
    log.info({ pubkey: operatorFeeKeypair.publicKey.toBase58() }, "operator fee keypair loaded");
  }

  // Backend + trade pipeline.
  const backend = makeB402Backend({
    masterSeed,
    rpcUrl: cfg.heliusRpcUrl,
    cluster: cfg.cluster,
    pool,
    ...(cfg.relayerUrl ? { relayerUrl: cfg.relayerUrl } : {}),
    ...(operatorFeeKeypair ? { operatorFeeKeypair } : {}),
  });
  const balance = makeBalanceStore(pool);
  const trade = makeTrade({ backend, balance });
  void trade; // referenced by future /buy /sell handlers (TODO: port from b402-trader)

  const handlers = makeTelegramHandlers({
    pool,
    authorizedTgUsers: cfg.authorizedTgUsers,
    resolvePubkey,
    wallet: backend,
  });

  // Telegram bot (v0.5 commands only — /follow group is v0.6).
  const bot = new Bot(cfg.telegramBotToken);
  bot.command("start", (c) => handlers.start(toCmdCtx(c)));
  bot.command("help", (c) => handlers.start(toCmdCtx(c)));
  bot.command("wallet", (c) => handlers.wallet(toCmdCtx(c)));
  bot.command("balance", (c) => handlers.balance(toCmdCtx(c)));
  bot.command("holdings", (c) => handlers.holdings(toCmdCtx(c)));
  bot.command("cashout", (c) => handlers.cashout(toCmdCtx(c)));

  // Deposit watcher. Delta-balance polling — see deposits.ts.
  const connection = makeConnection(cfg.heliusRpcUrl);
  startDepositWatcher({
    pool,
    connection,
    masterSeed,
    notify: async (tgId, text) => {
      await bot.api.sendMessage(tgId, text)
        .catch((e: unknown) => log.warn({ err: (e as Error).message }, "deposit DM failed"));
    },
  });

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

main().catch((e) => {
  log.error({ err: (e as Error).message }, "fatal");
  process.exit(1);
});
