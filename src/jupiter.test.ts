/**
 * Jupiter client — cache + circuit-breaker semantics. Mocks global fetch
 * so no real network call leaves the test process.
 *
 * Each test uses a fresh dynamic import via vi.resetModules() to bypass
 * the in-process Map caches (quoteCache, navCache, tokenInfoCache) from
 * earlier tests in the same file.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("jupiter client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("getQuote returns shape and caches the same (in, out, amount, slip) key", async () => {
    let calls = 0;
    const mock = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          inAmount: "1000000",
          outAmount: "12345",
          otherAmountThreshold: "12300",
          priceImpactPct: "0.01",
          inputMint: SOL_MINT,
          outputMint: USDC,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", mock);
    const { getQuote } = await import("./jupiter.js");
    const a = await getQuote(SOL_MINT, USDC, 1_000_000n, 50);
    const b = await getQuote(SOL_MINT, USDC, 1_000_000n, 50);
    expect(a.outAmount).toBe("12345");
    expect(b.outAmount).toBe("12345");
    expect(calls).toBe(1); // cache hit
  });

  it("valueTokensInSol opens a 30s circuit breaker on 429", async () => {
    let calls = 0;
    const mock = vi.fn(async () => {
      calls += 1;
      return new Response("", { status: 429 });
    });
    vi.stubGlobal("fetch", mock);
    const { valueTokensInSol } = await import("./jupiter.js");
    // 1st call: 3 attempts (3 fetches) then throws with "429"
    await expect(valueTokensInSol(USDC, 100n)).rejects.toThrow(/429/);
    // 2nd call: the breaker is open so we never fetch again.
    await expect(valueTokensInSol(USDC, 100n)).rejects.toThrow(/circuit breaker open/);
    expect(calls).toBe(3); // only the first call's 3 retries
  });

  it("getTokenInfo falls back to DexScreener when Jupiter misses", async () => {
    const mock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("lite-api.jup.ag")) {
        return new Response("", { status: 404 });
      }
      if (url.includes("dexscreener.com")) {
        return new Response(
          JSON.stringify([{ baseToken: { symbol: "PUMP", name: "Pumpy" } }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", mock);
    const { getTokenInfo } = await import("./jupiter.js");
    const info = await getTokenInfo("FreshMintPubkey1111111111111111111111111111");
    expect(info?.symbol).toBe("PUMP");
    // DexScreener doesn't return decimals — module assumes 6 (pump.fun default).
    expect(info?.decimals).toBe(6);
  });
});
