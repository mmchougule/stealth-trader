/**
 * rugcheck wrapper semantics. Mocks fetch to drive each branch:
 *   - pass=true on score-only no-danger response
 *   - pass=false on level==="danger" risk
 *   - pass=true fail-open on HTTP 5xx or thrown fetch
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("safety.checkToken", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("passes when no danger-level risks present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ score: 200, risks: [{ name: "Low LP", level: "warn" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { checkToken } = await import("./safety.js");
    const r = await checkToken("mint");
    expect(r.pass).toBe(true);
    expect(r.score).toBe(200);
  });

  it("blocks when a danger-level risk is reported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ score: 9999, risks: [{ name: "Honeypot", level: "danger" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { checkToken } = await import("./safety.js");
    const r = await checkToken("mint");
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/Honeypot/);
  });

  it("fails open on 5xx (manual review advised)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 502 })));
    const { checkToken } = await import("./safety.js");
    const r = await checkToken("mint");
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/manual review/i);
  });

  it("fails open on fetch throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const { checkToken } = await import("./safety.js");
    const r = await checkToken("mint");
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/RugCheck error/);
  });
});
