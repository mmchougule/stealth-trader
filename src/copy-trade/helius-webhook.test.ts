/**
 * Webhook reconciler contract:
 *   - first run with no persisted ID and no existing webhook → CREATE
 *   - subsequent run with persisted ID → UPDATE that exact webhook
 *   - existing webhook at our URL but no persisted ID → ADOPT (no create)
 *   - duplicates at our URL get DELETEd
 *
 * The Helius API is mocked with a stub fetch implementation. Postgres is
 * a tiny in-memory shim implementing only `.query()`.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { reconcileWebhook } from "./helius-webhook.js";

class MemPool {
  data = new Map<string, string>();
  async query(sql: string, params?: unknown[]) {
    if (/SELECT value FROM stealth.system_config/.test(sql)) {
      const k = params?.[0] as string;
      const v = this.data.get(k);
      return v ? { rowCount: 1, rows: [{ value: v }] } : { rowCount: 0, rows: [] };
    }
    if (/INSERT INTO stealth.system_config/.test(sql)) {
      const k = params?.[0] as string;
      const v = params?.[1] as string;
      this.data.set(k, v);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

interface Call { method: string; url: string; body?: unknown }

function stubFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  // @ts-expect-error: assigning global fetch for the test
  globalThis.fetch = async (u: string, init?: RequestInit) => {
    const c: Call = {
      method: init?.method ?? "GET",
      url: u,
      ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
    };
    calls.push(c);
    return handler(c);
  };
  return calls;
}

const baseOpts = {
  apiKey: "key",
  publicUrl: "https://host/webhook",
  authHeader: "secret",
  addresses: ["WalletA", "WalletB"],
  baseUrl: "https://example.test/webhooks",
};

describe("reconcileWebhook", () => {
  let pool: MemPool;
  beforeEach(() => { pool = new MemPool(); });

  it("CREATEs when nothing exists", async () => {
    const calls = stubFetch(async (c) => {
      if (c.method === "GET") return new Response(JSON.stringify([]), { status: 200 });
      if (c.method === "POST") return new Response(JSON.stringify({
        webhookID: "wh-new", webhookURL: baseOpts.publicUrl, accountAddresses: baseOpts.addresses,
        transactionTypes: ["ANY"], webhookType: "enhanced", authHeader: baseOpts.authHeader,
      }), { status: 200 });
      return new Response("", { status: 500 });
    });
    const r = await reconcileWebhook({ ...baseOpts, pool: pool as unknown as never });
    expect(r.webhookID).toBe("wh-new");
    expect(pool.data.get("helius_webhook_id")).toBe("wh-new");
    expect(calls.find((c) => c.method === "POST")).toBeDefined();
  });

  it("UPDATEs the persisted webhook on subsequent runs", async () => {
    pool.data.set("helius_webhook_id", "wh-persisted");
    const calls = stubFetch(async (c) => {
      if (c.method === "GET") return new Response(JSON.stringify([
        { webhookID: "wh-persisted", webhookURL: baseOpts.publicUrl, accountAddresses: ["old"],
          transactionTypes: ["SWAP"], webhookType: "enhanced", authHeader: "old" },
      ]), { status: 200 });
      if (c.method === "PUT") return new Response(JSON.stringify({
        webhookID: "wh-persisted", webhookURL: baseOpts.publicUrl, accountAddresses: baseOpts.addresses,
        transactionTypes: ["ANY"], webhookType: "enhanced", authHeader: baseOpts.authHeader,
      }), { status: 200 });
      return new Response("", { status: 500 });
    });
    const r = await reconcileWebhook({ ...baseOpts, pool: pool as unknown as never });
    expect(r.webhookID).toBe("wh-persisted");
    expect(r.accountAddresses).toEqual(baseOpts.addresses);
    expect(calls.find((c) => c.method === "POST")).toBeUndefined(); // no create
    expect(calls.find((c) => c.method === "PUT")).toBeDefined();
  });

  it("ADOPTs an existing webhook at our URL when no ID is persisted", async () => {
    stubFetch(async (c) => {
      if (c.method === "GET") return new Response(JSON.stringify([
        { webhookID: "wh-orphan", webhookURL: baseOpts.publicUrl, accountAddresses: [],
          transactionTypes: ["SWAP"], webhookType: "enhanced", authHeader: "old" },
      ]), { status: 200 });
      if (c.method === "PUT") return new Response(JSON.stringify({
        webhookID: "wh-orphan", webhookURL: baseOpts.publicUrl, accountAddresses: baseOpts.addresses,
        transactionTypes: ["ANY"], webhookType: "enhanced", authHeader: baseOpts.authHeader,
      }), { status: 200 });
      return new Response("", { status: 500 });
    });
    const r = await reconcileWebhook({ ...baseOpts, pool: pool as unknown as never });
    expect(r.webhookID).toBe("wh-orphan");
    expect(pool.data.get("helius_webhook_id")).toBe("wh-orphan");
  });

  it("DELETEs duplicate webhooks at our URL", async () => {
    const calls = stubFetch(async (c) => {
      if (c.method === "GET") return new Response(JSON.stringify([
        { webhookID: "wh-keep", webhookURL: baseOpts.publicUrl, accountAddresses: [], transactionTypes: ["ANY"], webhookType: "enhanced", authHeader: "x" },
        { webhookID: "wh-dupe", webhookURL: baseOpts.publicUrl, accountAddresses: [], transactionTypes: ["SWAP"], webhookType: "enhanced", authHeader: "x" },
      ]), { status: 200 });
      if (c.method === "PUT") return new Response(JSON.stringify({
        webhookID: "wh-keep", webhookURL: baseOpts.publicUrl, accountAddresses: baseOpts.addresses,
        transactionTypes: ["ANY"], webhookType: "enhanced", authHeader: baseOpts.authHeader,
      }), { status: 200 });
      if (c.method === "DELETE") return new Response("", { status: 200 });
      return new Response("", { status: 500 });
    });
    await reconcileWebhook({ ...baseOpts, pool: pool as unknown as never });
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain("/wh-dupe");
  });

  it("refuses to bootstrap when both addresses[] is empty AND no webhook exists", async () => {
    stubFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    await expect(
      reconcileWebhook({ ...baseOpts, addresses: [], pool: pool as unknown as never }),
    ).rejects.toThrow(/no addresses to register/);
  });
});

// Restore fetch between test files — vitest isolates module state per
// file but the global `fetch` we stubbed leaks otherwise.
afterAll(() => { delete (globalThis as { fetch?: unknown }).fetch; });
