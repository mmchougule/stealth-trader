/**
 * SDK construction parity — the fix for the "unknown:<frhex>" sell crash.
 *
 * Root cause: the b402 SDK stores shielded notes keyed by the Fr-reduced
 * tokenMint and only resolves them back to base58 for mints it has "learned".
 * A swap() learns its in/out mints in-process, but a COLD instance (bot
 * restart, second replica, notes restored from Postgres) never called swap()
 * — so a prior-session memecoin note renders as "unknown:<hex>", which is
 * non-base58 and throws "Non-base58 character" in the sell/holdings path.
 *
 * b402-trader avoids this by seeding learnMint(HOT_MINTS) right after ready()
 * and by passing photonRpc so holdings scans don't hit the throttled public
 * RPC. These tests lock in that the stealth-trader backend does the same.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

const learnMint = vi.fn();
const ready = vi.fn(async () => {});
const ctorArgs: any[] = [];

vi.mock("@b402ai/solana", () => ({
  B402Solana: class {
    wallet = { viewingPub: new Uint8Array(32) };
    constructor(args: any) { ctorArgs.push(args); }
    ready = ready;
    learnMint = learnMint;
    async holdings() { return { holdings: [] }; }
  },
}));

vi.mock("@lightprotocol/stateless.js", () => ({
  createRpc: (a: string, b: string) => ({ _photon: true, a, b }),
}));

vi.mock("./notePersistence.js", () => ({
  makeNotePersistence: () => ({ load: async () => null, save: async () => {} }),
}));

// A trivial deterministic seed; deriveUserKeypair just needs 32 bytes.
const masterSeed = new Uint8Array(32).fill(7);

function makeBackendUnderTest() {
  // Imported after the mocks are registered.
  return import("./b402-backend.js");
}

describe("makeB402Backend — SDK construction parity", () => {
  beforeEach(() => {
    learnMint.mockClear();
    ready.mockClear();
    ctorArgs.length = 0;
  });

  it("seeds learnMint for every HOT_MINT (incl. BONK) after ready()", async () => {
    const mod = await makeBackendUnderTest();
    const backend = mod.makeB402Backend({
      masterSeed,
      rpcUrl: "https://rpc.example",
      cluster: "mainnet",
      pool: { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => { throw new Error("unused"); }, end: async () => {} } as any,
    });

    // Any method that touches getSdk triggers construction + seeding.
    await backend.getNotes(1);

    const learned = learnMint.mock.calls.map((c) => (c[0] as PublicKey).toBase58());
    for (const m of mod.HOT_MINTS) {
      expect(learned).toContain(m);
    }
    // BONK is the regression token from the original crash report.
    expect(learned).toContain("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
  });

  it("passes photonRpc into the SDK constructor so holdings scans use the configured RPC", async () => {
    const mod = await makeBackendUnderTest();
    const backend = mod.makeB402Backend({
      masterSeed,
      rpcUrl: "https://rpc.example",
      cluster: "mainnet",
      pool: { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => { throw new Error("unused"); }, end: async () => {} } as any,
    });
    await backend.getNotes(1);

    // The FINAL (persistence-wired) construct must carry photonRpc.
    const last = ctorArgs[ctorArgs.length - 1];
    expect(last.photonRpc).toBeTruthy();
    expect(last.photonRpc._photon).toBe(true);
  });

  it("every HOT_MINT is valid base58 (learnMint(new PublicKey(m)) cannot throw)", async () => {
    const mod = await makeBackendUnderTest();
    for (const m of mod.HOT_MINTS) {
      expect(() => new PublicKey(m)).not.toThrow();
    }
  });
});
