/**
 * dex-ladder semantics. The SDK is mocked with a stub that fails N times
 * with controllable error strings before succeeding, so we can verify:
 *   - tx-too-large errors advance the maxAccounts ladder
 *   - route-stale errors retry in place once
 *   - fatal errors bubble immediately
 *   - the final attempt returns through unchanged
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { classifySwapErr, swapWithLadder, buildDefaultLadder } from "./dex-ladder.js";

const IN = new PublicKey("So11111111111111111111111111111111111111112");
const OUT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

interface CallRecord { maxAccounts?: number }

function makeStub(behavior: (i: number, call: CallRecord) => unknown) {
  const calls: CallRecord[] = [];
  return {
    calls,
    swap: async (opts: { maxAccounts?: number }) => {
      const idx = calls.length;
      const call: CallRecord = { maxAccounts: opts.maxAccounts };
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
  it("recognises route-stale", () => {
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
  it("succeeds at the first maxAccounts ceiling when the SDK accepts", async () => {
    const sdk = makeStub(() => ({ signature: "ok" }));
    const r = await swapWithLadder(sdk, { inMint: IN, outMint: OUT, amount: 1_000n, ladder: [32, 28] });
    expect(r).toEqual({ signature: "ok" });
    expect(sdk.calls.length).toBe(1);
    expect(sdk.calls[0].maxAccounts).toBe(32);
  });

  it("walks the ladder down on tx-too-large", async () => {
    const sdk = makeStub((i) => {
      if (i < 2) return new Error("tx_too_large");
      return { signature: "ok-after-shrink" };
    });
    const r = await swapWithLadder(sdk, { inMint: IN, outMint: OUT, amount: 1_000n, ladder: [32, 28, 24] });
    expect(r.signature).toBe("ok-after-shrink");
    expect(sdk.calls.map((c) => c.maxAccounts)).toEqual([32, 28, 24]);
  });

  it("retries route-stale in place once at the same maxAccounts", async () => {
    const sdk = makeStub((i) => {
      if (i === 0) return new Error("relayer 502 rpc_failure");
      return { signature: "ok-after-retry" };
    });
    const r = await swapWithLadder(sdk, { inMint: IN, outMint: OUT, amount: 1_000n, ladder: [32] });
    expect(r.signature).toBe("ok-after-retry");
    expect(sdk.calls.length).toBe(2);
    expect(sdk.calls[0].maxAccounts).toBe(32);
    expect(sdk.calls[1].maxAccounts).toBe(32);
  });

  it("throws fatal errors without retry", async () => {
    const sdk = makeStub(() => new Error("user rejected"));
    await expect(
      swapWithLadder(sdk, { inMint: IN, outMint: OUT, amount: 1_000n, ladder: [32, 28] }),
    ).rejects.toThrow(/user rejected/);
    expect(sdk.calls.length).toBe(1);
  });
});

describe("buildDefaultLadder", () => {
  it("starts from JUP_MAX_ACCOUNTS env when set, dedupes, drops <16", () => {
    const prev = process.env.JUP_MAX_ACCOUNTS;
    process.env.JUP_MAX_ACCOUNTS = "28";
    const l = buildDefaultLadder();
    expect(l).toEqual([28, 24, 20]);
    process.env.JUP_MAX_ACCOUNTS = prev;
  });
});
