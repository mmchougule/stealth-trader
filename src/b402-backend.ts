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

export interface BackendDeps {
  masterSeed: Uint8Array;
  rpcUrl: string;
  cluster: "mainnet" | "devnet" | "localnet";
  pool: DbPool;
  relayerUrl?: string;
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
}

interface SdkLike {
  ready(): Promise<void>;
  swap(opts: { inMint: PublicKey; outMint: PublicKey; amount: bigint }):
    Promise<{ signature?: string; sig?: string; outAmount?: bigint | string }>;
  holdings(opts?: { mint?: PublicKey; refresh?: boolean }):
    Promise<{ holdings: Array<{ id: string; mint: string | PublicKey; amount: string | bigint; decimals?: number }> }
            | Array<{ id: string; mint: string | PublicKey; amount: string | bigint; decimals?: number }>>;
  unshield(opts: { to: PublicKey; mint?: PublicKey; photonRpc?: unknown; alt?: PublicKey }):
    Promise<{ signature?: string; sig?: string }>;
  wallet?: { viewingPub: Uint8Array };
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
      const sdk = await getSdk(args.tgId);
      const res = await sdk.swap({
        inMint: NATIVE_MINT,
        outMint: new PublicKey(args.mint),
        amount: args.solLamports,
      });
      const txSignature = res.signature ?? res.sig ?? "";
      if (!txSignature) throw new Error("SDK returned no signature");
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

    async cashout(args) {
      const sdk = await getSdk(args.tgId);
      const mint = args.mint ? new PublicKey(args.mint) : NATIVE_MINT;
      const res = await sdk.unshield({
        to: new PublicKey(args.recipient),
        mint,
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
