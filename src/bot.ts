/**
 * Telegram bot entrypoint. Loads config, wires deps, registers handlers,
 * starts the deposit watcher, hands off to grammy.
 *
 * The v0.5 command surface lives in src/telegram/router.ts; each panel
 * lives in src/telegram/panels/*. This file is thin on purpose — boot
 * order is the only thing it owns.
 *
 * Out of scope for v1 (v0.6+): /follow, /follows, /unfollow. Copy-trade
 * lands once we have a hosted Helius webhook proxy so end-users don't
 * need ngrok.
 */
import "dotenv/config";
import fs from "node:fs";
import { Bot } from "grammy";
import { Keypair } from "@solana/web3.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { getPool, applySchema } from "./db/index.js";
import { parseMasterSeed } from "./wallet.js";
import { makeB402Backend, userPubkey, makeConnection } from "./b402-backend.js";
import { makeBalanceStore } from "./balance.js";
import { makeTrade } from "./trade.js";
import { registerHandlers } from "./telegram/router.js";
import { startDepositWatcher } from "./deposits.js";

function loadSolanaKeypairFile(p: string): Keypair {
  const expanded = p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p;
  const raw = JSON.parse(fs.readFileSync(expanded, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info({ cluster: cfg.cluster }, "stealth-trader starting");

  const pool = await getPool();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sqlDir = path.resolve(here, "..", "sql");
  await applySchema(pool, sqlDir);

  const masterSeed = parseMasterSeed(cfg.masterSeedHex);
  const operatorFeeKeypair = cfg.operatorFeeKeypairPath
    ? loadSolanaKeypairFile(cfg.operatorFeeKeypairPath)
    : undefined;
  if (operatorFeeKeypair) {
    log.info({ pubkey: operatorFeeKeypair.publicKey.toBase58() }, "operator fee keypair loaded");
  }

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

  const bot = new Bot(cfg.telegramBotToken);
  registerHandlers(bot, {
    pool,
    authorizedTgUsers: cfg.authorizedTgUsers,
    resolvePubkey: (tgId) => userPubkey(tgId, masterSeed),
    wallet: backend,
    ...(process.env.HELIUS_API_KEY ? { heliusApiKey: process.env.HELIUS_API_KEY } : {}),
    buy: trade,
    // privateSell isn't on SwapBackend yet; runSell handles the missing
    // executeSell gracefully with a v0.6 hint. Wire it the moment the
    // backend method lands.
    sell: {},
  });

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

main().catch((e) => {
  log.error({ err: (e as Error).message }, "fatal");
  process.exit(1);
});
