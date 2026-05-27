import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveMcpConfig, PUBLIC_MAINNET_RPC } from "./config.js";

describe("resolveMcpConfig — zero-config MCP boot", () => {
  let dir: string;
  let seedPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-mcp-cfg-"));
    seedPath = path.join(dir, "master-seed");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("generates + persists a 32-byte hex seed when none is set", () => {
    const c = resolveMcpConfig({}, seedPath);
    expect(c.masterSeedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(c.generatedSeedPath).toBe(seedPath);
    expect(fs.readFileSync(seedPath, "utf8").trim()).toBe(c.masterSeedHex);
  });

  it("reuses the persisted seed on the next boot (no regeneration)", () => {
    const first = resolveMcpConfig({}, seedPath);
    const second = resolveMcpConfig({}, seedPath);
    expect(second.masterSeedHex).toBe(first.masterSeedHex);
    expect(second.generatedSeedPath).toBeUndefined(); // already existed
  });

  it("prefers an explicit MASTER_SEED env and never writes the file", () => {
    const seed = "aa".repeat(32);
    const c = resolveMcpConfig({ MASTER_SEED: seed }, seedPath);
    expect(c.masterSeedHex).toBe(seed);
    expect(c.generatedSeedPath).toBeUndefined();
    expect(fs.existsSync(seedPath)).toBe(false);
  });

  it("defaults tgId to 1 and RPC to public mainnet (flagged) with no env", () => {
    const c = resolveMcpConfig({}, seedPath);
    expect(c.tgId).toBe(1);
    expect(c.rpcUrl).toBe(PUBLIC_MAINNET_RPC);
    expect(c.rpcDefaulted).toBe(true);
    expect(c.cluster).toBe("mainnet");
  });

  it("honors STEALTH_TG_ID + HELIUS_RPC_URL overrides", () => {
    const c = resolveMcpConfig(
      { STEALTH_TG_ID: "42", HELIUS_RPC_URL: "https://x.helius/?api-key=k" },
      seedPath,
    );
    expect(c.tgId).toBe(42);
    expect(c.rpcUrl).toBe("https://x.helius/?api-key=k");
    expect(c.rpcDefaulted).toBe(false);
  });
});
