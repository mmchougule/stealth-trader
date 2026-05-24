import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const base: NodeJS.ProcessEnv = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  AUTHORIZED_TG_USERS: "1,2,3",
  HELIUS_RPC_URL: "https://example.test/?api-key=x",
  HELIUS_WEBHOOK_SECRET: "deadbeef",
  DATABASE_URL: "postgres://localhost/test",
};

describe("loadConfig", () => {
  it("parses a minimal valid env", () => {
    const c = loadConfig(base);
    expect(c.telegramBotToken).toBe("123:abc");
    expect([...c.authorizedTgUsers]).toEqual([1, 2, 3]);
    expect(c.cluster).toBe("mainnet");
    expect(c.webhookPublicUrl).toBeNull();
    expect(c.relayerUrl).toBeNull();
    expect(c.dustMinLamports).toBeNull();
  });

  it("throws on missing required keys", () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("rejects non-numeric authorized users", () => {
    expect(() => loadConfig({ ...base, AUTHORIZED_TG_USERS: "1,xyz" })).toThrow(/non-numeric/);
  });

  it("rejects empty authorized user list", () => {
    expect(() => loadConfig({ ...base, AUTHORIZED_TG_USERS: ", ," })).toThrow();
  });

  it("validates cluster enum", () => {
    expect(() => loadConfig({ ...base, B402_CLUSTER: "testnet" })).toThrow(/B402_CLUSTER/);
  });

  it("accepts each supported cluster", () => {
    for (const c of ["mainnet", "devnet", "localnet"] as const) {
      expect(loadConfig({ ...base, B402_CLUSTER: c }).cluster).toBe(c);
    }
  });

  it("parses optional dust override", () => {
    expect(loadConfig({ ...base, DUST_MIN_LAMPORTS: "5000000" }).dustMinLamports).toBe(5_000_000n);
  });

  it("ignores invalid dust override silently (uses default later)", () => {
    expect(loadConfig({ ...base, DUST_MIN_LAMPORTS: "not-a-number" }).dustMinLamports).toBeNull();
    expect(loadConfig({ ...base, DUST_MIN_LAMPORTS: "0" }).dustMinLamports).toBeNull();
  });
});
