/**
 * dex-ladder semantics. The SDK is mocked with a stub that fails N times
 * with controllable error strings before succeeding, so we can verify:
 *   - tx-too-large errors advance the maxAccounts ladder (same dex set)
 *   - CPI-depth / no-routes errors advance the DEX ladder (reset maxAccounts)
 *   - route-stale errors retry in place once
 *   - fatal errors bubble immediately
 *   - the final attempt returns through unchanged
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { classifySwapErr, swapWithLadder, buildDefaultLadder, dexLadder, FLAT_CPI_DEXES } from "./dex-ladder.js";

const IN = new PublicKey("So11111111111111111111111111111111111111112");
const OUT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

interface CallRecord { maxAccounts?: number; dexes?: string }

function makeStub(behavior: (i: number, call: CallRecord) => unknown) {
  const calls: CallRecord[] = [];
  return {
    calls,
    swap: async (opts: { maxAccounts?: number; dexes?: string }) => {
      const idx = calls.length;
      const call: CallRecord = { maxAccounts: opts.maxAccounts, dexes: opts.dexes };
      calls.push(call);
      const out = behavior(idx, call);
      if (out instanceof Error) throw out;
      return out as { signature: string };
    },
  };
}

describe("classifySwapErr", () => {
  it("recognises the three tx-too-large symptoms", () => {
    expect(classifySwapErr("encoding overruns Uint8Array")).toBe("tx-too-large");
    expect(classifySwapErr("Error: tx_too_large 1456")).toBe("tx-too-large");
    expect(classifySwapErr("serialised tx exceeds 1232")).toBe("tx-too-large");
  });
  it("recognises CPI-depth + no-routes as cpi-or-no-routes", () => {
    expect(classifySwapErr("Cross-program invocation call depth too deep")).toBe("cpi-or-no-routes");
    expect(classifySwapErr("CallDepth")).toBe("cpi-or-no-routes");
    expect(classifySwapErr("No routes found")).toBe("cpi-or-no-routes");
    expect(classifySwapErr("NO_ROUTES_FOUND")).toBe("cpi-or-no-routes");
  });
  it("classifies a 502 that WRAPS call-depth as cpi, not route-stale", () => {
    // The real failure shape: relayer /adapt 502 rpc_failure whose detail is
    // "Simulation failed ... call depth too deep". Must NOT be route-stale,
    // or it retries the same nested route and fails identically.
    const real =
      'relayer /adapt 502 Bad Gateway: {"status":502,"title":"rpc_failure",' +
      '"detail":"sendRawTransaction failed: Simulation failed. Error processing ' +
      'Instruction 2: Cross-program invocation call depth too deep."}';
    expect(classifySwapErr(real)).toBe("cpi-or-no-routes");
  });
  it("recognises a BARE 502 / slippage as route-stale", () => {
    expect(classifySwapErr("0x1789 RouteStale")).toBe("route-stale");
    expect(classifySwapErr("custom 0x9 slippage")).toBe("route-stale");
    expect(classifySwapErr("relayer 502 rpc_failure")).toBe("route-stale");
  });
  it("treats unknown as fatal (don't retry)", () => {
    expect(classifySwapErr("user rejected")).toBe("fatal");
    expect(classifySwapErr("custom 0x42")).toBe("fatal");
  });
});

describe("swapWithLadder", () => {
  it("succeeds at the first dex set + maxAccounts ceiling when the SDK accepts", async () => {
    const sdk = makeStub(() => ({ signature: "ok" }));
    const r = await swapWithLadder(sdk, { inMint: IN, outMint: OUT, amount: 1_000n, ladder: [32, 28] });
    expect(r).toEqual({ signature: "ok" });
    expect(sdk.calls.length).toBe(1);
    expect(sdk.calls[0].maxAccounts).toBe(32);
    expect(sdk.calls[0].dexes).toBe(FLAT_CPI_DEXES);
  });

  it("walks the maxAccounts ladder down on tx-too-large, same dex set", async () => {
    const sdk = makeStub((i) => {
      if (i < 2) return new Error("tx_too_large");
      return { signature: "ok-after-shrink" };
    });
    const r = await swapWithLadder(sdk, {
      inMint: IN, outMint: OUT, amount: 1_000n,
      ladder: [32, 28, 24], dexLadderOverride: ["DEXA", "DEXB"],
    });
    expect(r.signature).toBe("ok-after-shrink");
    expect(sdk.calls.map((c) => c.maxAccounts)).toEqual([32, 28, 24]);
    expect(sdk.calls.every((c) => c.dexes === "DEXA")).toBe(true);
  });

  it("advances to the next DEX set on CPI-depth, resetting maxAccounts", async () => {
    const sdk = makeStub((i) => {
      // First dex set fails CPI-depth at the ceiling; second dex set succeeds.
      if (i === 0) return new Error("Cross-program invocation call depth too deep");
      return { signature: "ok-on-flat-dex" };
    });
    const r = await swapWithLadder(sdk, {
      inMint: IN, outMint: OUT, amount: 1_000n,
      ladder: [32, 28], dexLadderOverride: ["NESTED", "FLAT"],
    });
    expect(r.signature).toBe("ok-on-flat-dex");
    expect(sdk.calls.length).toBe(2);
    expect(sdk.calls[0]).toEqual({ maxAccounts: 32, dexes: "NESTED" });
    // Crucially: maxAccounts RESET to ceiling on the new dex set, not 28.
    expect(sdk.calls[1]).toEqual({ maxAccounts: 32, dexes: "FLAT" });
  });

  it("retries route-stale in place once at the same dex set + maxAccounts", async () => {
    const sdk = makeStub((i) => {
      if (i === 0) return new Error("relayer 502 rpc_failure");
      return { signature: "ok-after-retry" };
    });
    const r = await swapWithLadder(sdk, { inMint: IN, outMint: OUT, amount: 1_000n, ladder: [32] });
    expect(r.signature).toBe("ok-after-retry");
    expect(sdk.calls.length).toBe(2);
    expect(sdk.calls[0].maxAccounts).toBe(32);
    expect(sdk.calls[1].maxAccounts).toBe(32);
    expect(sdk.calls[0].dexes).toBe(sdk.calls[1].dexes);
  });

  it("throws fatal errors without retry", async () => {
    const sdk = makeStub(() => new Error("user rejected"));
    await expect(
      swapWithLadder(sdk, { inMint: IN, outMint: OUT, amount: 1_000n, ladder: [32, 28] }),
    ).rejects.toThrow(/user rejected/);
    expect(sdk.calls.length).toBe(1);
  });

  it("exhausts every dex set on persistent CPI-depth, then throws", async () => {
    const sdk = makeStub(() => new Error("call depth too deep"));
    await expect(
      swapWithLadder(sdk, {
        inMint: IN, outMint: OUT, amount: 1_000n,
        ladder: [32], dexLadderOverride: ["A", "B", "C"],
      }),
    ).rejects.toThrow(/call depth too deep/);
    expect(sdk.calls.map((c) => c.dexes)).toEqual(["A", "B", "C"]);
  });
});

describe("dexLadder", () => {
  it("defaults to FLAT_CPI_DEXES → wider → Phoenix-only", () => {
    const prev = process.env.DEX_FILTER;
    delete process.env.DEX_FILTER;
    const l = dexLadder();
    expect(l[0]).toBe(FLAT_CPI_DEXES);
    expect(l[2]).toBe("Phoenix");
    if (prev !== undefined) process.env.DEX_FILTER = prev;
  });
  it("honors DEX_FILTER override for the first entry", () => {
    const prev = process.env.DEX_FILTER;
    process.env.DEX_FILTER = "Phoenix,Raydium";
    expect(dexLadder()[0]).toBe("Phoenix,Raydium");
    if (prev !== undefined) process.env.DEX_FILTER = prev; else delete process.env.DEX_FILTER;
  });
});

describe("buildDefaultLadder", () => {
  it("starts from JUP_MAX_ACCOUNTS env when set, dedupes, drops <16", () => {
    const prev = process.env.JUP_MAX_ACCOUNTS;
    process.env.JUP_MAX_ACCOUNTS = "28";
    const l = buildDefaultLadder();
    expect(l).toEqual([28, 24, 20]);
    if (prev !== undefined) process.env.JUP_MAX_ACCOUNTS = prev; else delete process.env.JUP_MAX_ACCOUNTS;
  });
});
