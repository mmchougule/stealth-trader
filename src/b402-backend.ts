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
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { B402Solana } from "@b402ai/solana";
import type { DbPool } from "./db/index.js";
import { deriveUserKeypair } from "./wallet.js";
import { makeNotePersistence } from "./notePersistence.js";
import type { SwapBackend } from "./trade.js";

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
  /** Return shielded balances for the user, one row per mint. */
  getHoldings(tgId: number): Promise<Holding[]>;
  /** Unshield to a recipient. mint defaults to wSOL (so the recipient
   *  receives native SOL through the wSOL→SOL unwrap inside the SDK). */
  cashout(args: { tgId: number; recipient: string; mint?: string }): Promise<{ txSignature: string }>;
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
  swap(opts: { inMint: PublicKey; outMint: PublicKey; amount: bigint; maxAccounts?: number; slippageBps?: number }):
    Promise<{ signature?: string; sig?: string; outAmount?: bigint | string }>;
  holdings(opts?: { mint?: PublicKey; refresh?: boolean }):
    Promise<{ holdings: Array<{ id: string; mint: string | PublicKey; amount: string | bigint; decimals?: number }> }
            | Array<{ id: string; mint: string | PublicKey; amount: string | bigint; decimals?: number }>>;
  unshield(opts: { to: PublicKey; mint?: PublicKey; photonRpc?: unknown; alt?: PublicKey }):
    Promise<{ signature?: string; sig?: string }>;
  lend(opts: { mint: PublicKey; amount: bigint; market?: PublicKey }):
    Promise<{ signature?: string; sig?: string }>;
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

/**
 * Wrap `lamports` native SOL into the user's wSOL ATA. Idempotent:
 * the ATA-create instruction is the *Idempotent variant, the transfer
 * is value-typed, and syncNative reconciles the wSOL balance to the
 * underlying lamports.
 *
 * Required before sdk.shield(NATIVE_MINT, …). The b402 pool's Shield
 * instruction expects depositor_token_account to be an initialized
 * wSOL ATA — sdk.shield does NOT create it for you.
 */
async function wrapSolForShield(
  connection: Connection,
  userKp: Keypair,
  lamports: bigint,
): Promise<string> {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, userKp.publicKey);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      userKp.publicKey,
      ata,
      userKp.publicKey,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: userKp.publicKey,
      toPubkey: ata,
      lamports: Number(lamports),
    }),
    createSyncNativeInstruction(ata),
  );
  return sendAndConfirmTransaction(connection, tx, [userKp], {
    commitment: "confirmed",
    maxRetries: 3,
  });
}

/**
 * Robust swap with maxAccounts laddering. The b402 relayer's tx-build
 * buffer rejects oversized Jupiter routes with "encoding overruns
 * Uint8Array" / "tx_too_large" / "serialised tx" — depends on how many
 * accounts the Jupiter route + nullifier sibling-ix wrapping needs.
 * Ladder shrinks maxAccounts until it fits the 1232 B v0 cap.
 *
 * Also retries route-staleness transients (0x9 SlippageToleranceExceeded,
 * 0x1789 RouteStale, 502 rpc_failure) once at the current maxAcc.
 *
 * Ported from b402-trader/src/b402-client.ts::executePrivateSwap. Kept
 * minimal — DEX laddering, stale-note refresh, and Merkle-root retry
 * live in b402-trader because copy-trade hits arbitrary memecoin pairs
 * across many sequential swaps; the stealth-trader smoke does one
 * SOL→USDC swap and doesn't need them.
 */
async function swapWithLadder(
  sdk: SdkLike,
  args: { inMint: PublicKey; outMint: PublicKey; amount: bigint; slippageBps?: number },
): Promise<{ signature?: string; sig?: string; outAmount?: bigint | string }> {
  const ceiling = Number(process.env.JUP_MAX_ACCOUNTS ?? 32);
  const ladder = Array.from(new Set([ceiling, 28, 24, 20])).filter((v) => v >= 16);
  let lastErr: unknown = null;
  for (let i = 0; i < ladder.length; i++) {
    const maxAccounts = ladder[i]!;
    const isLast = i === ladder.length - 1;
    try {
      return await sdk.swap({
        inMint: args.inMint,
        outMint: args.outMint,
        amount: args.amount,
        slippageBps: args.slippageBps ?? 50,
        maxAccounts,
      });
    } catch (e) {
      lastErr = e;
      const msg = (e as Error).message ?? "";
      const txTooLarge = msg.includes("encoding overruns Uint8Array")
        || msg.includes("tx_too_large")
        || msg.includes("serialised tx");
      if (txTooLarge && !isLast) continue; // ladder down

      const routeStale = msg.includes("0x9")
        || msg.includes("0x1789")
        || (msg.includes("502") && msg.includes("rpc_failure"));
      if (routeStale) {
        // Single in-place retry at same maxAccounts (route refreshes in <1s).
        try {
          return await sdk.swap({
            inMint: args.inMint,
            outMint: args.outMint,
            amount: args.amount,
            slippageBps: args.slippageBps ?? 50,
            maxAccounts,
          });
        } catch (e2) {
          lastErr = e2;
          // Fall through — if retry also failed for a non-ladder reason, surface.
        }
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("swap failed at all maxAccounts");
}

/**
 * Pre-create the recipient's ATA for `mint` paid by the operator. Idempotent.
 * Without this, sdk.unshield falls back to using the user's derived keypair
 * (which is intentionally near-empty after shielding) to pay ~0.002 SOL rent,
 * and the tx fails with "account (0) insufficient funds for rent".
 *
 * Returns the ATA address either way.
 */
async function ensureRecipientAta(
  connection: Connection,
  operator: Keypair,
  recipient: PublicKey,
  mint: PublicKey,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, recipient);
  const info = await connection.getAccountInfo(ata);
  if (info) return ata;
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      operator.publicKey, // fee payer + rent payer
      ata,
      recipient,
      mint,
    ),
  );
  await sendAndConfirmTransaction(connection, tx, [operator], {
    commitment: "confirmed",
    maxRetries: 3,
  });
  return ata;
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
      const sdkWithPersist = new B402Solana({
        cluster: deps.cluster,
        keypair,
        rpcUrl: deps.rpcUrl,
        notesPersistence: { load: persistence.load, save: persistence.save },
        ...(deps.relayerUrl ? { relayerUrl: deps.relayerUrl } : {}),
      } as never) as unknown as SdkLike;
      await sdkWithPersist.ready();
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
      return [...byMint.entries()].map(([mint, v]) => ({
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
      const { photonRpc, alt } = await buildPhase9Deps(deps.rpcUrl, deps.cluster);
      const res = await sdk.unshield({
        to: recipient,
        mint,
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
