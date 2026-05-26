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
import { makeTrade, computeBuyFee } from "./trade.js";
import { registerHandlers } from "./telegram/router.js";
import { startDepositWatcher } from "./deposits.js";
import { getTokenInfo, getTokenDecimals, getQuote, SOL_MINT } from "./jupiter.js";
import { getHolding, recordSell } from "./holdings.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

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
  const connection = makeConnection(cfg.heliusRpcUrl);

  // Resolve a token's symbol + decimals for the cost-basis ledger. The ledger
  // is the authoritative source the sell picker + /holdings read from (NOT the
  // SDK note labels), so a long-tail memecoin stays sellable even when the SDK
  // would render its shielded note as "unknown:<frhex>" on a cold instance.
  const tokenMeta = async (mint: string): Promise<{ symbol: string | null; decimals: number }> => {
    const [ti, chainDecimals] = await Promise.all([
      getTokenInfo(mint).catch(() => null),
      getTokenDecimals(connection, mint).catch(() => null),
    ]);
    return { symbol: ti?.symbol ?? null, decimals: chainDecimals ?? ti?.decimals ?? 6 };
  };

  const trade = makeTrade({ backend, balance, tokenMeta });

  // Read the user's spendable public SOL from the ledger. The Buy panel's
  // PUBLIC section funds a shield+swap from this balance.
  const publicSolLamports = async (tgId: number): Promise<bigint> => {
    const r = await pool.query<{ sol_balance_lamports: string }>(
      `SELECT sol_balance_lamports FROM stealth.users WHERE tg_id = $1`,
      [tgId],
    );
    return r.rowCount && r.rowCount > 0 ? BigInt(r.rows[0]!.sol_balance_lamports) : 0n;
  };

  // The Buy panel adapts trade.executeBuy plus a set of read-only lookups.
  // Every lookup is wrapped at the panel layer (Promise.catch), so failures
  // degrade to "no notes" / "no quote" rather than throwing into grammy.
  const buyDeps = {
    executeBuy: (args: { tgId: number; mint: string; solLamports: bigint }) => trade.executeBuy(args),
    publicSolLamports,
    shieldedSolNotes: async (tgId: number): Promise<bigint[]> => {
      const notes = await backend.getNotes(tgId, WSOL_MINT);
      return notes.map((n) => n.amount);
    },
    tokenMeta,
    quoteTokensOut: async (mint: string, solLamports: bigint): Promise<bigint | null> => {
      const q = await getQuote(SOL_MINT, mint, solLamports, 100).catch(() => null);
      return q ? BigInt(q.outAmount) : null;
    },
    computeBuyFee,
  };

  const sellDeps = {
    // Adapt backend.privateSell → the SellDeps.executeSell shape. Wrapped in
    // the same ok/error envelope as buy so the panel renders a clean receipt
    // or a failure line.
    executeSell: async (args: { tgId: number; mint: string; rawAmount: bigint }) => {
      try {
        const r = await backend.privateSell(args);
        // On-chain sell landed. Debit the cost-basis ledger + append a trade
        // row so /holdings + the sell picker reflect the reduced position.
        // The picker offers only real note denominations, so rawAmount always
        // equals a spendable note — no note-snap reconciliation needed.
        // SWAP_FEE is taken on the output by the SDK adapter; we record the
        // net SOL the user actually received.
        try {
          const h = await getHolding(args.tgId, args.mint);
          await recordSell({
            tgId: args.tgId,
            mint: args.mint,
            symbol: h?.symbol ?? null,
            decimals: h?.decimals ?? 0,
            tokensSold: args.rawAmount,
            solReceived: r.solReceived,
            feeLamports: 0n,
            txSignature: r.txSignature,
          });
        } catch (ledgerErr) {
          // The sell is irreversibly on chain; surface a reconcile-able error
          // rather than pretending it failed (which would imply funds are safe).
          log.error(
            { tgId: args.tgId, mint: args.mint, sig: r.txSignature, err: (ledgerErr as Error).message },
            "sell: recordSell failed AFTER on-chain success — manual reconcile needed",
          );
          return {
            ok: false as const,
            error: `Sold on chain but ledger write failed — contact operator with tx ${r.txSignature}`,
          };
        }
        return { ok: true as const, txSignature: r.txSignature, solReceived: r.solReceived };
      } catch (e) {
        // Log the real backend error here — the panel only shows the user a
        // one-line "sell failed", and the router's onCallback wrapper never
        // sees this (it's a returned envelope, not a throw). Without this log
        // the failure is invisible in `pnpm start`.
        log.error(
          { tgId: args.tgId, mint: args.mint, rawAmount: args.rawAmount.toString(), err: (e as Error).message, stack: (e as Error).stack },
          "privateSell failed",
        );
        return { ok: false as const, error: (e as Error).message };
      }
    },
    // Source the sell picker from the SDK shielded view (the actual pool
    // state, now indexer-resolved to base58 — so a token bought before the
    // ledger existed still shows). Overlay the cost-basis ledger only for
    // symbol/decimals when we have them. wSOL is excluded by getHoldings (it's
    // private SOL, not a sellable token).
    holdings: async (tgId: number) => {
      const sdkRows = await backend.getHoldings(tgId);
      return Promise.all(sdkRows.map(async (h) => {
        const led = await getHolding(tgId, h.mint).catch(() => undefined);
        return {
          mint: h.mint,
          amount: h.amount,
          decimals: led?.decimals ?? h.decimals,
          symbol: led?.symbol ?? null,
        };
      }));
    },
    tokenNotes: async (tgId: number, mint: string): Promise<bigint[]> => {
      const notes = await backend.getNotes(tgId, mint);
      return notes.map((n) => n.amount);
    },
    quoteSolOut: async (mint: string, rawAmount: bigint): Promise<bigint | null> => {
      const q = await getQuote(mint, SOL_MINT, rawAmount, 100).catch(() => null);
      return q ? BigInt(q.outAmount) : null;
    },
  };

  // Compose the wallet dep: the SDK-backed backend plus the cost-basis ledger
  // (for /holdings PnL) and a SOL quote. localHoldings reads stealth.holdings
  // (what the user paid); quoteSolOut prices the position now.
  const walletDeps = {
    ...backend,
    // /holdings sources from the SDK shielded view (actual pool state,
    // indexer-resolved) so every real position shows — then overlays the
    // cost-basis ledger for symbol + PnL where a recorded buy exists.
    localHoldings: async (tgId: number) => {
      const sdkRows = await backend.getHoldings(tgId);
      return Promise.all(sdkRows.map(async (h) => {
        const led = await getHolding(tgId, h.mint).catch(() => undefined);
        return {
          mint: h.mint,
          amount: h.amount,
          decimals: led?.decimals ?? h.decimals,
          symbol: led?.symbol ?? null,
          totalInvestedLamports: led ? BigInt(led.total_invested_lamports) : 0n,
        };
      }));
    },
    quoteSolOut: async (mint: string, rawAmount: bigint): Promise<bigint | null> => {
      const q = await getQuote(mint, SOL_MINT, rawAmount, 100).catch(() => null);
      return q ? BigInt(q.outAmount) : null;
    },
  };

  const bot = new Bot(cfg.telegramBotToken);
  registerHandlers(bot, {
    pool,
    authorizedTgUsers: cfg.authorizedTgUsers,
    resolvePubkey: (tgId) => userPubkey(tgId, masterSeed),
    wallet: walletDeps,
    ...(process.env.HELIUS_API_KEY ? { heliusApiKey: process.env.HELIUS_API_KEY } : {}),
    buy: buyDeps,
    sell: sellDeps,
  });

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
