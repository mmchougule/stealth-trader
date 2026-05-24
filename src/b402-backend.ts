/**
 * SwapBackend implementation backed by @b402ai/solana.
 *
 * For each Telegram user, we lazily construct one B402Solana SDK
 * instance keyed on that user's derived keypair. The instances are
 * cached for the lifetime of the bot process so per-user NoteStores
 * keep their warm state.
 *
 * The actual shield + swap call happens inside `privateBuy`. The SDK
 * does the rest:
 *   - shield SOL (or recycle an existing same-size wSOL note)
 *   - swap that note for `mint` via Jupiter through the b402 adapter
 *   - leafIndex on the output note is read from the on-chain
 *     CommitmentAppended event (SDK 0.0.33 Layer A fix), eliminating
 *     phantom-note creation.
 *
 * This module is the ONE place that imports the b402 SDK. Everything
 * else in the codebase talks to the `SwapBackend` interface.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { B402Solana } from "@b402ai/solana";
import { deriveUserKeypair } from "./wallet.js";
import type { SwapBackend } from "./trade.js";

export interface BackendDeps {
  masterSeed: Uint8Array;
  rpcUrl: string;
  cluster: "mainnet" | "devnet" | "localnet";
  relayerUrl?: string;
}

export function makeB402Backend(deps: BackendDeps): SwapBackend {
  const cache = new Map<number, Promise<B402Solana>>();

  async function getSdk(tgId: number): Promise<B402Solana> {
    let p = cache.get(tgId);
    if (p) return p;

    const keypair = deriveUserKeypair(tgId, deps.masterSeed);
    p = (async () => {
      const sdk = new B402Solana({
        cluster: deps.cluster,
        keypair,
        rpcUrl: deps.rpcUrl,
        ...(deps.relayerUrl ? { relayerUrl: deps.relayerUrl } : {}),
      } as never);
      // Cast: the SDK's constructor type is permissive about optional
      // fields. We rely on the documented set of options; if the SDK
      // tightens its types in a future release, the call shape stays.
      await (sdk as { ready: () => Promise<void> }).ready();
      return sdk;
    })();
    cache.set(tgId, p);
    return p;
  }

  return {
    async privateBuy(args: { tgId: number; mint: string; solLamports: bigint }) {
      const sdk = await getSdk(args.tgId);
      const outMint = new PublicKey(args.mint);
      // The SDK handles shield-or-recycle + swap atomically. It accepts
      // a SOL amount (lamports) as `amount` when `inMint` is WSOL.
      const res = await (sdk as unknown as {
        swap(opts: { inMint: PublicKey; outMint: PublicKey; amount: bigint }):
          Promise<{ signature?: string; sig?: string; outAmount?: bigint | string }>;
      }).swap({
        inMint: new PublicKey("So11111111111111111111111111111111111111112"),
        outMint,
        amount: args.solLamports,
      });
      const txSignature = res.signature ?? res.sig ?? "";
      if (!txSignature) throw new Error("SDK returned no signature");
      const tokensReceived = res.outAmount === undefined ? 0n : BigInt(res.outAmount);
      return { txSignature, tokensReceived };
    },
  };
}

/**
 * Tiny helper: derive a user's public Solana address (string) without
 * needing to construct an SDK instance. Used by /start and /wallet.
 */
export function userPubkey(tgId: number, masterSeed: Uint8Array): string {
  return deriveUserKeypair(tgId, masterSeed).publicKey.toBase58();
}

/**
 * Build a vanilla web3 Connection for the configured RPC. Used by the
 * deposit watcher (which doesn't need the SDK).
 */
export function makeConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, "confirmed");
}
