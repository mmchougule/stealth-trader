/**
 * Concrete backend over @b402ai/solana. One B402Solana SDK instance per
 * Telegram user, lazy + cached for the lifetime of the bot process.
 *
 * Exposes three operations the rest of the codebase composes on:
 *   - privateBuy(args)            shield + swap, signed by the relayer
 *   - getHoldings(tgId)           per-mint shielded balances
 *   - cashout({ tgId, recipient, mint? })   unshield to a fresh address
 *
 * The NoteStore is persisted to Postgres (stealth.note_store_state) so
 * cold boot doesn't lose the user's shielded position. Persistence is
 * keyed by viewing-pub-hex so multiple bot replicas at the same
 * MASTER_SEED converge on the same store.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { B402Solana } from "@b402ai/solana";
import type { DbPool } from "./db/index.js";
import { deriveUserKeypair } from "./wallet.js";
import { makeNotePersistence } from "./notePersistence.js";
import type { SwapBackend } from "./trade.js";
import { swapWithLadder } from "./b402/dex-ladder.js";
import { wrapSolForShield } from "./b402/ensure-wsol.js";
import { ensureRecipientAta } from "./b402/recipient-ata.js";

const WSOL_MINT_B58 = NATIVE_MINT.toBase58();

// Whitelisted mints — seed the SDK's Fr-reducer registry at construction so
// that post-restart (cold instance) holdings()/getNotes() resolve memecoin
// notes to their base58 mint instead of the opaque "unknown:<frhex>" label.
//
// Why this is load-bearing: the SDK stores notes keyed by the Fr-reduced
// tokenMint (a field element), and only `learnMint(pubkey)` teaches it the
// reverse mapping back to base58. `swap()` learns its in/out mints in-process,
// but a fresh SDK instance (bot restart, second replica, or notes restored
// from Postgres persistence) has NEVER called swap() — so without this seed,
// a shielded BONK note from a prior session resolves to "unknown:<hex>",
// which is non-base58 and makes `new PublicKey(mint)` throw "Non-base58
// character" in the sell/holdings path. Mirrors b402-trader's HOT_MINTS seed.

// Hosted b402 indexer. The SDK uses it to (a) enumerate ALL shielded notes
// for a viewing key — including ones shielded on another device / before a
// restore — and (b) resolve ANY token mint, not just the HOT_MINTS whitelist.
// Without it the SDK falls back to proveMostRecentLeaf (rightmost-only) +
// local mint registry, which is why arbitrary-mint notes rendered as
// "unknown:<frhex>". It's a convenience oracle, not a trust root: the SDK
// verifies the indexer's claimed Merkle root against on-chain TreeState before
// using any proof, so a tampered indexer can only DoS. Override via env.
const DEFAULT_INDEXER_URL = "https://b402-solana-indexer-api-62092339396.us-central1.run.app";
const INDEXER_URL = process.env.B402_INDEXER_URL ?? DEFAULT_INDEXER_URL;

export const HOT_MINTS: string[] = [
  NATIVE_MINT.toBase58(),                          // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",  // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",  // WIF
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",  // POPCAT
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",   // JUP
];

/** True only for a real base58 SPL mint that's a tradeable TOKEN position.
 *  Rejects:
 *    - wSOL — that's private SOL (the base currency), not a sellable token;
 *             it must not show up in the Sell list as "Sell wSOL".
 *    - opaque "unknown:<hex>" labels the SDK emits for mints it hasn't
 *             learned — these aren't base58 and can't be quoted/swapped, and
 *             feeding one to `new PublicKey()` throws "Non-base58 character".
 *    - any string that isn't a valid base58 ed25519 pubkey. */
function isTradeableTokenMint(mint: string): boolean {
  if (mint === WSOL_MINT_B58) return false;
  if (mint.includes(":")) return false; // "unknown:..." and other labels
  try { new PublicKey(mint); return true; } catch { return false; }
}

export interface BackendDeps {
  masterSeed: Uint8Array;
  rpcUrl: string;
  cluster: "mainnet" | "devnet" | "localnet";
  pool: DbPool;
  relayerUrl?: string;
  /** Optional operator keypair that pays one-time recipient ATA rent in
   *  cashout (~0.002 SOL per (recipient, mint) pair). The SDK falls back
   *  to the user's tiny derived keypair otherwise, which fails for fresh
   *  recipients with "insufficient funds for rent". */
  operatorFeeKeypair?: Keypair;
}

export interface Holding {
  /** Mint as base58. Display side may resolve to a symbol via Helius DAS. */
  mint: string;
  /** Raw token units (BigInt-stringified for transport). */
  amount: string;
  decimals: number;
}

export interface WalletBackend extends SwapBackend {
  /** Sell a shielded token note back to SOL: swap(token → wSOL). Mirror
   *  of privateBuy. `rawAmount` must equal one existing token note's
   *  value (getNotes(tgId, mint) lists them). Returns lamports received. */
  privateSell(args: { tgId: number; mint: string; rawAmount: bigint }): Promise<{ txSignature: string; solReceived: bigint }>;
  /** Return shielded balances for the user, one row per mint. */
  getHoldings(tgId: number): Promise<Holding[]>;
  /** Unshield to a recipient. mint defaults to wSOL (so the recipient
   *  receives native SOL through the wSOL→SOL unwrap inside the SDK).
   *  `noteId` pins the exact shielded note to spend; omitting it lets the
   *  SDK fall back to its most-recently-shielded note. */
  cashout(args: { tgId: number; recipient: string; mint?: string; noteId?: string }): Promise<{ txSignature: string }>;
  /** Lend a shielded token into Kamino. Burns one shielded note, mints a
   *  Kamino voucher note. Mainnet only (Kamino isn't on devnet). `amount`
   *  must equal one existing note's value — call `getNotes` first if you
   *  need to discover spendable sizes. */
  lend(args: { tgId: number; mint: string; amount: bigint }): Promise<{ txSignature: string }>;
  /** Per-note view of the shielded position. The b402 adapt circuit
   *  consumes exactly one note per private swap/lend; aggregating across
   *  notes (as getHoldings does) loses the size information you need to
   *  pick a valid `amount` for lend/swap. */
  getNotes(tgId: number, mint?: string): Promise<Array<{ id: string; mint: string; amount: bigint }>>;
}

interface SdkLike {
  ready(): Promise<void>;
  shield(opts: { mint: PublicKey; amount: bigint }):
    Promise<{ signature?: string; sig?: string }>;
  swap(opts: { inMint: PublicKey; outMint: PublicKey; amount: bigint; maxAccounts?: number; slippageBps?: number; dexes?: string }):
    Promise<{ signature?: string; sig?: string; outAmount?: bigint | string }>;
  holdings(opts?: { mint?: PublicKey; refresh?: boolean }):
    Promise<{ holdings: Array<{ id: string; mint: string | PublicKey; amount: string | bigint; decimals?: number }> }
            | Array<{ id: string; mint: string | PublicKey; amount: string | bigint; decimals?: number }>>;
  unshield(opts: { to: PublicKey; mint?: PublicKey; note?: unknown; photonRpc?: unknown; alt?: PublicKey }):
    Promise<{ signature?: string; sig?: string }>;
  lend(opts: { mint: PublicKey; amount: bigint; market?: PublicKey }):
    Promise<{ signature?: string; sig?: string }>;
  /** Teach the SDK a mint pubkey so holdings()/getNotes() resolve its
   *  Fr-reduced tokenMint back to base58 instead of "unknown:<hex>". */
  learnMint(mint: PublicKey): void;
  wallet?: { viewingPub: Uint8Array };
}

/**
 * Phase-9 unshield requires (1) a Photon RPC client to read the dual-note tree
 * state and (2) the b402 address-lookup-table to keep the tx under 1232 bytes.
 * Build them lazily; both are cluster-pinned constants and have no per-user state.
 */
async function buildPhase9Deps(rpcUrl: string, cluster: "mainnet" | "devnet" | "localnet"):
  Promise<{ photonRpc: unknown; alt: PublicKey }>
{
  const { createRpc } = await import("@lightprotocol/stateless.js");
  const { B402_ALT_MAINNET, B402_ALT_DEVNET } = await import("@b402ai/solana-shared");
  const altStr = cluster === "mainnet" ? B402_ALT_MAINNET
    : cluster === "devnet" ? B402_ALT_DEVNET
    : "";
  if (!altStr) throw new Error(`no b402 ALT for cluster=${cluster}`);
  const photonRpc = createRpc(rpcUrl, rpcUrl);
  return { photonRpc, alt: new PublicKey(altStr) };
}

export function makeB402Backend(deps: BackendDeps): WalletBackend {
  const cache = new Map<number, Promise<SdkLike>>();

  async function getSdk(tgId: number): Promise<SdkLike> {
    let p = cache.get(tgId);
    if (p) return p;
    const keypair: Keypair = deriveUserKeypair(tgId, deps.masterSeed);
    // viewing-pub hex for Postgres persistence key.
    // The SDK derives the viewing pubkey from the keypair seed; the bot
    // matches by deriving the same way in the NoteStore adapter.
    p = (async (): Promise<SdkLike> => {
      // Quick derivation of viewing-pub hex matching the SDK's own. We
      // ask the SDK directly after ready() so we never duplicate the
      // derivation logic and risk drift.
      const sdk = new B402Solana({
        cluster: deps.cluster,
        keypair,
        rpcUrl: deps.rpcUrl,
        ...(deps.relayerUrl ? { relayerUrl: deps.relayerUrl } : {}),
      } as never) as unknown as SdkLike;
      await sdk.ready();
      const viewingPubHex = sdk.wallet
        ? Buffer.from(sdk.wallet.viewingPub).toString("hex")
        : keypair.publicKey.toBase58(); // last-resort key — won't collide cross-user
      const persistence = makeNotePersistence(deps.pool, viewingPubHex);
      // Re-construct the SDK now that we have the persistence adapter.
      // SDKs vary on whether persistence can be applied post-init; we
      // pass it in the constructor for safety.
      //
      // photonRpc: route the SDK's holdings/balance scans + validity proofs
      // through our configured (Helius/Triton) RPC. Without it the SDK falls
      // back to the public mainnet RPC for Photon reads, which 429s on the
      // first holdings({ refresh: true }). Mirrors b402-trader's photonRpc wiring.
      const { createRpc } = await import("@lightprotocol/stateless.js");
      const photonRpc = createRpc(deps.rpcUrl, deps.rpcUrl);
      const sdkWithPersist = new B402Solana({
        cluster: deps.cluster,
        keypair,
        rpcUrl: deps.rpcUrl,
        photonRpc,
        // Indexer: lets the SDK enumerate ALL of a viewing key's shielded notes
        // (any device, post-restore) and resolve ANY mint to base58 — not just
        // the HOT_MINTS whitelist. This is the real fix for "unknown:<frhex>"
        // on arbitrary tokens; HOT_MINTS + the ledger are belt-and-suspenders.
        indexerUrl: INDEXER_URL,
        notesPersistence: { load: persistence.load, save: persistence.save },
        ...(deps.relayerUrl ? { relayerUrl: deps.relayerUrl } : {}),
      } as never) as unknown as SdkLike;
      await sdkWithPersist.ready();
      // Seed the mint registry so cold-instance holdings()/getNotes() resolve
      // memecoin notes to base58 instead of "unknown:<frhex>" (the label that
      // crashes the sell path via "Non-base58 character"). swap() learns its
      // mints in-process, but a restored-from-Postgres note store never went
      // through swap() in THIS process — so we seed eagerly here.
      for (const m of HOT_MINTS) {
        try { sdkWithPersist.learnMint(new PublicKey(m)); } catch { /* ignore */ }
      }
      return sdkWithPersist;
    })();
    cache.set(tgId, p);
    return p;
  }

  return {
    async privateBuy(args) {
      // Three-step private buy:
      //   (1) wrap native SOL → user's wSOL ATA (Solana doesn't have
      //       a "shield SOL" primitive; b402 takes SPL tokens)
      //   (2) sdk.shield: pool moves the wSOL ATA balance into a
      //       shielded note owned by the user's spending key
      //   (3) sdk.swap: spends that shielded note, lands a new shielded
      //       note of `args.mint` via the b402 Jupiter adapter
      // Phase-10 partial-spend will collapse (2)+(3); until then it's
      // three on-chain txs per private buy.
      const userKp = deriveUserKeypair(args.tgId, deps.masterSeed);
      const conn = new Connection(deps.rpcUrl, "confirmed");
      await wrapSolForShield(conn, userKp, args.solLamports);
      const sdk = await getSdk(args.tgId);
      await sdk.shield({ mint: NATIVE_MINT, amount: args.solLamports });
      // swapWithLadder: maxAccounts ladder + route-stale retry. Same
      // pattern b402-trader uses for production copy-trades. Fixes the
      // "encoding overruns Uint8Array" / "tx_too_large" failures that
      // hit when Jupiter routes happen to be too long for the relayer's
      // tx-build buffer.
      const res = await swapWithLadder(sdk, {
        inMint: NATIVE_MINT,
        outMint: new PublicKey(args.mint),
        amount: args.solLamports,
      });
      const txSignature = res.signature ?? res.sig ?? "";
      if (!txSignature) throw new Error("SDK returned no signature on swap");
      const tokensReceived = res.outAmount === undefined ? 0n : BigInt(res.outAmount);
      return { txSignature, tokensReceived };
    },

    async privateSell(args) {
      // Sell is buy in reverse: spend an existing shielded TOKEN note,
      // swap it to wSOL via the b402 Jupiter adapter, land a shielded
      // wSOL note. No shield step — the input note already exists from a
      // prior buy. `rawAmount` must equal one existing token note's value
      // (the adapt circuit consumes exactly one note); callers get valid
      // sizes from getNotes(tgId, mint).
      // Guard: a malformed/opaque mint (e.g. the SDK's "unknown:<hex>" label)
      // would throw the cryptic "Non-base58 character" deep in PublicKey.
      // Fail fast with a clear, user-readable reason instead.
      if (!isTradeableTokenMint(args.mint)) {
        throw new Error(`can't sell this position — its mint isn't a tradeable token (${args.mint})`);
      }
      const sdk = await getSdk(args.tgId);
      const res = await swapWithLadder(sdk, {
        inMint: new PublicKey(args.mint),
        outMint: NATIVE_MINT,
        amount: args.rawAmount,
      });
      const txSignature = res.signature ?? res.sig ?? "";
      if (!txSignature) throw new Error("SDK returned no signature on sell swap");
      const solReceived = res.outAmount === undefined ? 0n : BigInt(res.outAmount);
      return { txSignature, solReceived };
    },

    async getHoldings(tgId) {
      const sdk = await getSdk(tgId);
      const raw = await sdk.holdings({ refresh: true });
      const entries = Array.isArray(raw) ? raw : raw.holdings;
      // Aggregate per-mint: sum amounts across notes of the same mint.
      const byMint = new Map<string, { amount: bigint; decimals: number }>();
      for (const e of entries) {
        const mint = typeof e.mint === "string" ? e.mint : e.mint.toBase58();
        const amt = typeof e.amount === "string" ? BigInt(e.amount) : e.amount;
        const cur = byMint.get(mint) ?? { amount: 0n, decimals: e.decimals ?? 0 };
        cur.amount += amt;
        if (e.decimals !== undefined) cur.decimals = e.decimals;
        byMint.set(mint, cur);
      }
      return [...byMint.entries()]
        // Only real, tradeable token mints. Drops wSOL (private SOL, shown in
        // Wallet — not a sellable token) and "unknown:<hex>" labels the SDK
        // emits for unlearned mints (non-base58 → would crash the sell path).
        .filter(([mint]) => isTradeableTokenMint(mint))
        .map(([mint, v]) => ({
          mint,
          amount: v.amount.toString(),
          decimals: v.decimals,
        }));
    },

    async getNotes(tgId, mint) {
      const sdk = await getSdk(tgId);
      const raw = await sdk.holdings({ refresh: true });
      const entries = Array.isArray(raw) ? raw : raw.holdings;
      const all = entries.map((e) => ({
        id: e.id,
        mint: typeof e.mint === "string" ? e.mint : e.mint.toBase58(),
        amount: typeof e.amount === "string" ? BigInt(e.amount) : e.amount,
      }));
      return mint ? all.filter((n) => n.mint === mint) : all;
    },

    async lend(args) {
      if (deps.cluster !== "mainnet") {
        throw new Error(`lend requires mainnet (Kamino isn't deployed on ${deps.cluster})`);
      }
      const sdk = await getSdk(args.tgId);
      const res = await sdk.lend({
        mint: new PublicKey(args.mint),
        amount: args.amount,
      });
      const txSignature = res.signature ?? res.sig ?? "";
      if (!txSignature) throw new Error("SDK returned no signature on lend");
      return { txSignature };
    },

    async cashout(args) {
      const sdk = await getSdk(args.tgId);
      const mint = args.mint ? new PublicKey(args.mint) : NATIVE_MINT;
      const recipient = new PublicKey(args.recipient);
      // Operator-pays-rent: pre-create recipient ATA so SDK's fallback
      // (which would use the user's near-empty derived keypair) is bypassed.
      // Skipped when no operator keypair is configured; in that case the
      // user's keypair must hold ~0.002 SOL for first-time recipients.
      if (deps.operatorFeeKeypair) {
        const conn = new Connection(deps.rpcUrl, "confirmed");
        await ensureRecipientAta(conn, deps.operatorFeeKeypair, recipient, mint);
      }
      // Pin the exact note when the caller chose one (Withdraw picker). The
      // SDK's holdings() entries ARE spendable notes; find the one by id and
      // pass it so unshield doesn't fall back to most-recently-shielded only.
      let note: unknown;
      if (args.noteId) {
        const raw = await sdk.holdings({ refresh: true });
        const entries = Array.isArray(raw) ? raw : raw.holdings;
        note = entries.find((e: { id?: string }) => e.id === args.noteId);
        if (!note) throw new Error("note not found or already spent — refresh and try again");
      }
      const { photonRpc, alt } = await buildPhase9Deps(deps.rpcUrl, deps.cluster);
      const res = await sdk.unshield({
        to: recipient,
        mint,
        ...(note ? { note } : {}),
        photonRpc,
        alt,
      });
      const txSignature = res.signature ?? res.sig ?? "";
      if (!txSignature) throw new Error("SDK returned no signature on unshield");
      return { txSignature };
    },
  };
}

export function userPubkey(tgId: number, masterSeed: Uint8Array): string {
  return deriveUserKeypair(tgId, masterSeed).publicKey.toBase58();
}

export function makeConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, "confirmed");
}
