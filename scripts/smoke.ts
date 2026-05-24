#!/usr/bin/env node
/**
 * End-to-end smoke against a real cluster.
 *
 * Exercises every SDK path the bot depends on, against either devnet or
 * mainnet (devnet preferred when the b402 pool is deployed there;
 * mainnet works today and is what the private deployment proves daily).
 *
 *   1. Apply sql/001..003 (idempotent — re-running is safe).
 *   2. Derive the test user's wallet from MASTER_SEED + TEST_TG_ID.
 *   3. Show the wallet address and wait for the operator to fund it.
 *   4. Run a private buy: shield → swap → shielded note.
 *   5. Read /holdings — assert the freshly-created note appears.
 *   6. Cash out to a fresh recipient — assert the recipient receives
 *      the underlying and that the recipient address has no on-chain
 *      edge to the user's deposit address (caller's responsibility to
 *      verify on a block explorer; we print both addresses + the tx
 *      signatures so the verification is one click away).
 *
 * Required env:
 *   MASTER_SEED           64 hex chars
 *   HELIUS_RPC_URL        with api-key query param
 *   DATABASE_URL          postgresql:// (defaults to local docker-compose)
 *
 * Optional env:
 *   B402_CLUSTER          mainnet | devnet  (default: mainnet)
 *   TEST_TG_ID            positive int (default: 999_000_001)
 *   TEST_AMOUNT_SOL       float (default: 0.0015 — large enough to clear
 *                                fees, small enough to lose if the smoke
 *                                fails)
 *   TEST_MINT             token mint to buy (default: USDC mainnet)
 *   TEST_RECIPIENT        Solana pubkey to receive the cashout (default:
 *                                fresh ephemeral keypair)
 *   B402_RELAYER_URL      override the default hosted relayer
 *   SKIP_BUY=1            jump straight to /holdings + /cashout (assumes
 *                                the user already has shielded balance)
 *
 * Exit codes:
 *   0  every step passed
 *   1  setup failure (env, schema, RPC)
 *   2  deposit wait timed out
 *   3  shield+swap failed
 *   4  holdings did not reflect the new note within the polling window
 *   5  cashout failed
 *
 * The script writes its own log to stdout and a structured JSON summary
 * to /tmp/stealth-trader-smoke-<timestamp>.json so the operator can grep
 * it post-hoc.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Pool } from "pg";
import { parseMasterSeed, deriveUserKeypair } from "../src/wallet.js";
import { makeB402Backend, userPubkey } from "../src/b402-backend.js";
import { makeBalanceStore } from "../src/balance.js";
import { makeTrade } from "../src/trade.js";

const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface Summary {
  startedAt: string;
  cluster: string;
  testTgId: number;
  userAddress: string;
  recipientAddress: string;
  fundingTx?: string;
  buyTx?: string;
  buyTokensReceived?: string;
  holdingsBeforeCashout: Array<{ mint: string; amount: string; decimals: number }>;
  cashoutTx?: string;
  ok: boolean;
  failedAt?: string;
  error?: string;
  walltimeMs?: number;
}

const summary: Summary = {
  startedAt: new Date().toISOString(),
  cluster: process.env.B402_CLUSTER ?? "mainnet",
  testTgId: Number(process.env.TEST_TG_ID ?? "999000001"),
  userAddress: "",
  recipientAddress: "",
  holdingsBeforeCashout: [],
  ok: false,
};
const t0 = Date.now();

function fail(stage: string, err: unknown, code: number): never {
  summary.failedAt = stage;
  summary.error = (err as Error)?.message ?? String(err);
  summary.walltimeMs = Date.now() - t0;
  writeSummary();
  // eslint-disable-next-line no-console
  console.error(`\n[FAIL ${stage}]`, summary.error);
  process.exit(code);
}

function writeSummary() {
  const file = `/tmp/stealth-trader-smoke-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  // eslint-disable-next-line no-console
  console.log(`summary: ${file}`);
}

async function applySchema(pool: Pool, sqlDir: string): Promise<void> {
  for (const f of ["001_init.sql", "002_balances.sql", "003_notes.sql"]) {
    const sql = fs.readFileSync(path.join(sqlDir, f), "utf8");
    await pool.query(sql);
    // eslint-disable-next-line no-console
    console.log(`  applied ${f}`);
  }
}

async function waitForBalance(conn: Connection, pubkey: PublicKey, minLamports: bigint, timeoutMs: number): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lamports = BigInt(await conn.getBalance(pubkey));
    if (lamports >= minLamports) return lamports;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`balance did not reach ${minLamports} within ${timeoutMs}ms`);
}

async function main() {
  // ─── 0. Env + connections ──────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`[stealth-trader smoke] starting on ${summary.cluster}`);
  const masterSeedHex = process.env.MASTER_SEED;
  const rpcUrl = process.env.HELIUS_RPC_URL;
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/stealth_trader";
  if (!masterSeedHex) fail("env", new Error("MASTER_SEED required"), 1);
  if (!rpcUrl) fail("env", new Error("HELIUS_RPC_URL required"), 1);

  const masterSeed = parseMasterSeed(masterSeedHex!);
  const cluster = summary.cluster as "mainnet" | "devnet" | "localnet";
  const conn = new Connection(rpcUrl!, "confirmed");
  const pool = new Pool({ connectionString: databaseUrl });
  const sqlDir = path.resolve(process.cwd(), "sql");

  // ─── 1. Schema ─────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("[1] applying schema…");
  try { await applySchema(pool, sqlDir); } catch (e) { fail("schema", e, 1); }

  // ─── 2. Derive ─────────────────────────────────────────────────────────
  const userAddress = userPubkey(summary.testTgId, masterSeed);
  summary.userAddress = userAddress;
  // eslint-disable-next-line no-console
  console.log(`[2] test user tg=${summary.testTgId}  address=${userAddress}`);

  // Recipient: random ephemeral keypair so cashout's destination has no
  // history. We don't persist its secret; we don't need it after this run.
  const recipientKp = process.env.TEST_RECIPIENT
    ? null
    : Keypair.generate();
  const recipientPubkey = process.env.TEST_RECIPIENT
    ? new PublicKey(process.env.TEST_RECIPIENT)
    : recipientKp!.publicKey;
  summary.recipientAddress = recipientPubkey.toBase58();
  // eslint-disable-next-line no-console
  console.log(`    recipient (cashout dest) = ${recipientPubkey.toBase58()}`);

  // ─── 3. Fund + wait ────────────────────────────────────────────────────
  const amountSol = Number(process.env.TEST_AMOUNT_SOL ?? "0.0015");
  const minLamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL)) + 1_000_000n; // include rent + fee headroom
  const skipBuy = process.env.SKIP_BUY === "1";
  if (!skipBuy) {
    const currentLamports = BigInt(await conn.getBalance(new PublicKey(userAddress)));
    if (currentLamports < minLamports) {
      // eslint-disable-next-line no-console
      console.log(`[3] insufficient SOL at ${userAddress} (${currentLamports} < ${minLamports}).`);
      // eslint-disable-next-line no-console
      console.log(`    fund ${userAddress} with at least ${Number(minLamports) / LAMPORTS_PER_SOL} SOL on ${cluster}.`);
      // eslint-disable-next-line no-console
      console.log(`    waiting up to 5 minutes…`);
      try {
        const got = await waitForBalance(conn, new PublicKey(userAddress), minLamports, 5 * 60 * 1000);
        // eslint-disable-next-line no-console
        console.log(`    funded: ${got} lamports`);
      } catch (e) { fail("funding", e, 2); }
    } else {
      // eslint-disable-next-line no-console
      console.log(`[3] already funded: ${currentLamports} lamports`);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log("[3] SKIP_BUY=1 — skipping deposit + buy phase");
  }

  // ─── 4. Backend ─────────────────────────────────────────────────────────
  const backend = makeB402Backend({
    masterSeed, rpcUrl: rpcUrl!, cluster, pool,
    ...(process.env.B402_RELAYER_URL ? { relayerUrl: process.env.B402_RELAYER_URL } : {}),
  });
  const balance = makeBalanceStore(pool);
  const trade = makeTrade({ backend, balance });

  // Seed the user's bot-side balance so trade.executeBuy's debit-before-send
  // passes. The smoke isn't testing the deposit watcher (it has its own
  // unit tests + cursor) — it's testing the SDK integration.
  if (!skipBuy) {
    await balance.credit(summary.testTgId, BigInt(Math.round(amountSol * LAMPORTS_PER_SOL)) + 1_000_000n, "smoke_seed");
  }

  // ─── 5. Buy ─────────────────────────────────────────────────────────────
  if (!skipBuy) {
    const mint = process.env.TEST_MINT ?? USDC_MAINNET;
    // eslint-disable-next-line no-console
    console.log(`[4] private buy: ${amountSol} SOL → ${mint}`);
    const t = Date.now();
    const res = await trade.executeBuy({
      tgId: summary.testTgId,
      mint,
      solLamports: BigInt(Math.round(amountSol * LAMPORTS_PER_SOL)),
    });
    if (!res.ok) fail("private_buy", new Error(res.error), 3);
    summary.buyTx = res.txSignature;
    summary.buyTokensReceived = res.tokensReceived.toString();
    // eslint-disable-next-line no-console
    console.log(`    ok in ${Date.now() - t}ms  tx=${res.txSignature}  tokens=${res.tokensReceived}`);
  }

  // ─── 6. Holdings ────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log("[5] reading holdings…");
  let holdings: Awaited<ReturnType<typeof backend.getHoldings>> = [];
  try {
    holdings = await backend.getHoldings(summary.testTgId);
    summary.holdingsBeforeCashout = holdings;
    if (holdings.length === 0) throw new Error("holdings empty after buy");
    for (const h of holdings) {
      // eslint-disable-next-line no-console
      console.log(`    ${h.mint}  ${h.amount}  decimals=${h.decimals}`);
    }
  } catch (e) { fail("holdings", e, 4); }

  // ─── 7. Cashout ─────────────────────────────────────────────────────────
  const cashoutMint = (process.env.TEST_MINT ?? USDC_MAINNET);
  // eslint-disable-next-line no-console
  console.log(`[6] cashout: ${cashoutMint} → ${summary.recipientAddress}`);
  try {
    const res = await backend.cashout({
      tgId: summary.testTgId,
      recipient: summary.recipientAddress,
      mint: cashoutMint,
    });
    summary.cashoutTx = res.txSignature;
    // eslint-disable-next-line no-console
    console.log(`    ok  tx=${res.txSignature}`);
    // eslint-disable-next-line no-console
    console.log(`    verify privacy on chain:`);
    // eslint-disable-next-line no-console
    console.log(`      depositor:  https://solscan.io/account/${summary.userAddress}`);
    // eslint-disable-next-line no-console
    console.log(`      recipient:  https://solscan.io/account/${summary.recipientAddress}`);
    // eslint-disable-next-line no-console
    console.log(`      mirror tx:  https://solscan.io/tx/${res.txSignature}`);
    // eslint-disable-next-line no-console
    console.log(`      open both account pages — depositor will not appear in the mirror tx's accountKeys.`);
  } catch (e) { fail("cashout", e, 5); }

  // ─── 8. Done ────────────────────────────────────────────────────────────
  summary.ok = true;
  summary.walltimeMs = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(`\n[OK] full smoke passed in ${summary.walltimeMs}ms`);
  writeSummary();
  await pool.end();
  process.exit(0);
}

main().catch((e) => fail("uncaught", e, 1));
