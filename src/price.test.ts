import { describe, it, expect, beforeEach, vi } from "vitest";

describe("price.getSolUsd", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("returns the price from Coingecko on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ solana: { usd: 142.5 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { getSolUsd, _resetPriceCacheForTests } = await import("./price.js");
    _resetPriceCacheForTests();
    expect(await getSolUsd()).toBe(142.5);
  });

  it("caches successful reads for 60s", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify({ solana: { usd: 100 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const { getSolUsd, _resetPriceCacheForTests } = await import("./price.js");
    _resetPriceCacheForTests();
    await getSolUsd();
    await getSolUsd();
    expect(calls).toBe(1);
  });

  it("returns null on upstream failure when cache is empty (no hardcoded fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ETIMEDOUT"); }));
    const { getSolUsd, _resetPriceCacheForTests } = await import("./price.js");
    _resetPriceCacheForTests();
    expect(await getSolUsd()).toBe(null);
  });
});
