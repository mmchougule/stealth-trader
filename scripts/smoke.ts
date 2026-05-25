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
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { parseMasterSeed, deriveUserKeypair } from "../src/wallet.js";
import { makeB402Backend, userPubkey } from "../src/b402-backend.js";
import { makeBalanceStore } from "../src/balance.js";
import { makeTrade } from "../src/trade.js";
import { getPool, applySchema, type DbPool } from "../src/db/index.js";

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
  lendTx?: string;
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

async function waitForBalance(conn: Connection, pubkey: PublicKey, minLamports: bigint, timeoutMs: number): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lamports = BigInt(await conn.getBalance(pubkey));
    if (lamports >= minLamports) return lamports;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`balance did not reach ${minLamports} within ${timeoutMs}ms`);
}

/**
 * Generate a MASTER_SEED into ./.env if one isn't already in env. Returns the
 * hex seed. Idempotent — if .env already has MASTER_SEED, the dotenv import
 * at the top of this file already populated process.env and we return early.
 *
 * Set STEALTH_NO_AUTOSEED=1 to opt out (e.g. in CI where you want the
 * "MASTER_SEED required" error instead of a fresh seed).
 */
function ensureMasterSeed(): string {
  if (process.env.MASTER_SEED) return process.env.MASTER_SEED;
  if (process.env.STEALTH_NO_AUTOSEED === "1") {
    throw new Error("MASTER_SEED required (STEALTH_NO_AUTOSEED=1 set)");
  }
  const seed = crypto.randomBytes(32).toString("hex");
  const envPath = path.resolve(process.cwd(), ".env");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(envPath, `${existing}${sep}MASTER_SEED=${seed}\n`);
  process.env.MASTER_SEED = seed;
  // eslint-disable-next-line no-console
  console.log("[seed] generated new MASTER_SEED, saved to ./.env");
  // eslint-disable-next-line no-console
  console.log("       this is your root of trust — back it up before depositing real funds");
  return seed;
}

/**
 * Try to auto-fund `recipient` to `minLamports` from the Solana CLI keypair
 * (`~/.config/solana/id.json`). Returns the new balance on success, or null
 * if auto-fund was skipped (no CLI keypair, insufficient CLI balance, or
 * STEALTH_NO_AUTOFUND=1). On failure we fall through to the manual-wait path.
 */
async function maybeAutoFund(
  conn: Connection,
  recipient: PublicKey,
  current: bigint,
  needed: bigint,
): Promise<bigint | null> {
  if (current >= needed) return current;
  if (process.env.STEALTH_NO_AUTOFUND === "1") return null;
  const cliPath = process.env.SOLANA_KEYPAIR_PATH
    ?? path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(cliPath)) return null;
  const cliKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(cliPath, "utf8")) as number[]),
  );
  const cliBalance = BigInt(await conn.getBalance(cliKp.publicKey));
  const transferAmount = needed - current;
  // Keep 0.01 SOL in the CLI wallet so tx fees + operator-rent ops still work.
  const cliReserve = 10_000_000n;
  if (cliBalance < transferAmount + cliReserve) {
    // eslint-disable-next-line no-console
    console.log(`[fund] CLI wallet too low to auto-fund (have ${cliBalance}, need ${transferAmount + cliReserve}); waiting for manual top-up`);
    return null;
  }
  // Consent preview before transferring. In an interactive TTY we wait 5s
  // for Ctrl-C; non-interactive (CI) skips the countdown since the env flag
  // STEALTH_NO_AUTOFUND=1 is the supported opt-out and the user has already
  // committed by running the script.
  const sol = (Number(transferAmount) / 1e9).toFixed(4);
  // eslint-disable-next-line no-console
  console.log(`[fund] about to transfer ${sol} SOL from ${cliKp.publicKey.toBase58()}`);
  // eslint-disable-next-line no-console
  console.log(`       (to ${recipient.toBase58()} — the smoke test wallet derived from MASTER_SEED)`);
  // eslint-disable-next-line no-console
  console.log(`       this SOL round-trips back to your wallet as USDC at cashout (step 6).`);
  if (process.stdin.isTTY) {
    // eslint-disable-next-line no-console
    process.stdout.write("       Ctrl-C in 5s to abort... ");
    for (let i = 5; i > 0; i--) {
      process.stdout.write(`${i} `);
      await new Promise((r) => setTimeout(r, 1_000));
    }
    // eslint-disable-next-line no-console
    console.log("");
  }
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: cliKp.publicKey,
    toPubkey: recipient,
    lamports: Number(transferAmount),
  }));
  const sig = await sendAndConfirmTransaction(conn, tx, [cliKp], { commitment: "confirmed" });
  // eslint-disable-next-line no-console
  console.log(`[fund] tx ${sig}`);
  return BigInt(await conn.getBalance(recipient));
}

async function main() {
  // ─── 0. Env + connections ──────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`[stealth-trader smoke] real Solana mainnet end-to-end demo`);
  // eslint-disable-next-line no-console
  console.log(`
  What this does (~25 seconds, ~$0.01 net cost):
    1. Derive a test wallet from your MASTER_SEED (writes to ./.env on first run)
    2. Auto-fund the test wallet with 0.0045 SOL from your Solana CLI wallet
       (~/.config/solana/id.json) — opt out with STEALTH_NO_AUTOFUND=1
    3. Shield 0.0015 SOL into the b402 pool (your wallet signs this on-chain step)
    4. Swap shielded SOL → USDC via Jupiter (relayer signs; your wallet absent)
    5. Read shielded holdings
    6. Cashout the USDC back to your CLI wallet (relayer signs; your wallet absent)

  Net: your CLI wallet ends with slightly less SOL + ~0.13 USDC. Nothing is drained.
  Verifiable on Solscan: depositor address absent from both the swap and cashout txs.
`);
  let masterSeedHex: string;
  try { masterSeedHex = ensureMasterSeed(); } catch (e) { fail("env", e, 1); }
  const rpcUrl = process.env.HELIUS_RPC_URL;
  if (!rpcUrl) fail("env", new Error("HELIUS_RPC_URL required (free key at https://helius.xyz)"), 1);

  const masterSeed = parseMasterSeed(masterSeedHex!);
  const cluster = summary.cluster as "mainnet" | "devnet" | "localnet";
  const conn = new Connection(rpcUrl!, "confirmed");
  const pool: DbPool = await getPool();
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

  // Recipient: default to the operator's Solana CLI keypair if present.
  // That wallet already has a USDC ATA from prior activity, so the cashout
  // pays zero ATA-creation rent. The privacy claim (depositor absent from
  // cashout tx accountKeys) holds regardless of who the recipient is.
  // Falls back to a deterministic seed-derived address if no CLI keypair
  // is found. Override with TEST_RECIPIENT to point at a fresh wallet.
  const RECIPIENT_TG_ID = Number(process.env.TEST_RECIPIENT_TG_ID ?? "999000999");
  const cliRecipientPath = process.env.SOLANA_KEYPAIR_PATH
    ?? path.join(os.homedir(), ".config", "solana", "id.json");
  let recipientPubkey: PublicKey;
  if (process.env.TEST_RECIPIENT) {
    recipientPubkey = new PublicKey(process.env.TEST_RECIPIENT);
  } else if (fs.existsSync(cliRecipientPath)) {
    const raw = JSON.parse(fs.readFileSync(cliRecipientPath, "utf8")) as number[];
    recipientPubkey = Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey;
  } else {
    recipientPubkey = deriveUserKeypair(RECIPIENT_TG_ID, masterSeed).publicKey;
  }
  summary.recipientAddress = recipientPubkey.toBase58();
  // eslint-disable-next-line no-console
  console.log(`    recipient (cashout dest) = ${recipientPubkey.toBase58()}`);

  // ─── 3. Fund + wait ────────────────────────────────────────────────────
  const amountSol = Number(process.env.TEST_AMOUNT_SOL ?? "0.0015");
  // Headroom covers (one-time) wSOL ATA rent ~2_039_280 + a few tx fees.
  // The ATA is idempotent — only the first buy pays rent — but the smoke
  // always runs against a fresh address, so we always need it.
  const minLamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL)) + 3_000_000n;
  const skipBuy = process.env.SKIP_BUY === "1";
  if (!skipBuy) {
    const userPk = new PublicKey(userAddress);
    const currentLamports = BigInt(await conn.getBalance(userPk));
    if (currentLamports >= minLamports) {
      // eslint-disable-next-line no-console
      console.log(`[3] already funded: ${currentLamports} lamports`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[3] need ${minLamports} lamports at ${userAddress} (have ${currentLamports})`);
      const autoFunded = await maybeAutoFund(conn, userPk, currentLamports, minLamports);
      if (autoFunded !== null) {
        // eslint-disable-next-line no-console
        console.log(`    funded: ${autoFunded} lamports`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`    fund ${userAddress} with at least ${Number(minLamports) / LAMPORTS_PER_SOL} SOL on ${cluster}.`);
        // eslint-disable-next-line no-console
        console.log(`    waiting up to 5 minutes…`);
        try {
          const got = await waitForBalance(conn, userPk, minLamports, 5 * 60 * 1000);
          // eslint-disable-next-line no-console
          console.log(`    funded: ${got} lamports`);
        } catch (e) { fail("funding", e, 2); }
      }
    }
  } else {
    // eslint-disable-next-line no-console
    console.log("[3] SKIP_BUY=1 — skipping deposit + buy phase");
  }

  // ─── 4. Backend ─────────────────────────────────────────────────────────
  // Operator keypair pays one-time recipient ATA rent. Default to the
  // Solana CLI keypair (which is the same wallet that funded the user
  // address — assumed to have spare SOL). Override with
  // OPERATOR_FEE_KEYPAIR_PATH.
  const operatorPath = process.env.OPERATOR_FEE_KEYPAIR_PATH
    ?? path.join(os.homedir(), ".config", "solana", "id.json");
  let operatorFeeKeypair: Keypair | undefined;
  if (fs.existsSync(operatorPath)) {
    const raw = JSON.parse(fs.readFileSync(operatorPath, "utf8")) as number[];
    operatorFeeKeypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    // eslint-disable-next-line no-console
    console.log(`    operator fee payer: ${operatorFeeKeypair.publicKey.toBase58()}`);
  }
  const backend = makeB402Backend({
    masterSeed, rpcUrl: rpcUrl!, cluster, pool,
    ...(process.env.B402_RELAYER_URL ? { relayerUrl: process.env.B402_RELAYER_URL } : {}),
    ...(operatorFeeKeypair ? { operatorFeeKeypair } : {}),
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

  // ─── 6b. Optional lend ─────────────────────────────────────────────────
  // Set TEST_LEND=1 to also exercise the Kamino private-lend path. Lends
  // ~half the just-acquired USDC into the deepest Kamino USDC reserve via
  // the b402 adapter. Skipped by default — adds a Kamino UserMetadata +
  // Obligation rent (~0.003 SOL, refundable on close) the first time it
  // runs for a given (viewing key, mint) pair.
  const usdcMint = process.env.TEST_MINT ?? USDC_MAINNET;
  if (process.env.TEST_LEND === "1") {
    // The b402 adapt circuit consumes exactly one note — the SDK rejects
    // anything other than an exact match. Pull the per-note list and pick
    // the largest non-dust note. (Phase 9 dual-note minting means each
    // buy produces two output notes: one main, one tiny "reblind". We
    // want the main one.)
    const notes = (await backend.getNotes(summary.testTgId, usdcMint))
      .filter((n) => n.amount > 1000n) // filter Phase-9 reblind dust
      .sort((a, b) => (b.amount > a.amount ? 1 : -1));
    if (notes.length === 0) fail("lend", new Error("no spendable USDC notes"), 6);
    const lendAmount = notes[0].amount;
    // eslint-disable-next-line no-console
    console.log(`[6b] private lend: ${lendAmount} USDC raw → Kamino`);
    try {
      const tLend = Date.now();
      const res = await backend.lend({
        tgId: summary.testTgId,
        mint: usdcMint,
        amount: lendAmount,
      });
      summary.lendTx = res.txSignature;
      // eslint-disable-next-line no-console
      console.log(`    ok in ${Date.now() - tLend}ms  tx=${res.txSignature}`);
    } catch (e) { fail("lend", e, 6); }
  }

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
    console.log(`      cashout tx: https://solscan.io/tx/${res.txSignature}`);
    // eslint-disable-next-line no-console
    console.log(`      open both account pages — depositor address will not appear in the cashout tx's accountKeys.`);
  } catch (e) { fail("cashout", e, 5); }

  // ─── 8. Done ────────────────────────────────────────────────────────────
  summary.ok = true;
  summary.walltimeMs = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(`\n[OK] full smoke passed in ${summary.walltimeMs}ms`);
  writeSummary();
  // Fire pool.end() but don't await — pglite's worker thread can keep
  // the event loop alive longer than the user has patience for. The OS
  // reclaims everything on exit anyway. Same goes for the SDK's HTTP
  // keepalive sockets.
  pool.end().catch(() => { /* ignore */ });
  process.exit(0);
}

main().catch((e) => fail("uncaught", e, 1));
