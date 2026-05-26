/**
 * Holdings ledger semantics against a real pglite instance. We can't unit
 * test the SQL math with the in-memory shim used by balance.test.ts —
 * UPSERTs + CHECK constraints + transaction rollback are pglite-only.
 *
 * Each test creates the stealth schema and the holdings/trades tables
 * inline so we don't depend on applySchema() side-effects.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makePglitePool } from "./db/pglite-pool.js";

const SCHEMA = `
  CREATE SCHEMA IF NOT EXISTS stealth;
  CREATE TABLE IF NOT EXISTS stealth.holdings (
    tg_id BIGINT NOT NULL,
    mint TEXT NOT NULL,
    amount NUMERIC(40, 0) NOT NULL DEFAULT 0,
    decimals INTEGER NOT NULL,
    symbol TEXT,
    avg_cost_lamports BIGINT NOT NULL DEFAULT 0,
    total_invested_lamports BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tg_id, mint),
    CONSTRAINT amount_nonneg CHECK (amount >= 0)
  );
  CREATE TABLE IF NOT EXISTS stealth.trades (
    id BIGSERIAL PRIMARY KEY,
    tg_id BIGINT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    mint TEXT NOT NULL,
    symbol TEXT,
    sol_lamports BIGINT NOT NULL,
    token_amount NUMERIC(40, 0) NOT NULL,
    token_decimals INTEGER NOT NULL,
    fee_lamports BIGINT NOT NULL DEFAULT 0,
    tx_signature TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

describe("holdings ledger", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stealth-holdings-test-"));
    process.env.DATABASE_URL = `pglite:${tmpDir}`;
    const pool = await makePglitePool(tmpDir);
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
      await pool.query(stmt);
    }
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
  });

  it("recordBuy upserts holdings, writes a trades row, recomputes avg_cost", async () => {
    const { recordBuy, getHolding, listHoldings } = await import("./holdings.js");
    await recordBuy({
      tgId: 1001,
      mint: "MintA",
      symbol: "AAA",
      decimals: 6,
      solLamports: 1_000_000n,
      tokensReceived: 500_000n,
      feeLamports: 50_000n,
      txSignature: "sig-a-1",
    });
    const h1 = await getHolding(1001, "MintA");
    expect(h1?.amount).toBe("500000");
    expect(BigInt(h1!.total_invested_lamports)).toBe(1_000_000n);
    // avg_cost_lamports = invested * 1e9 / amount = 1e6 * 1e9 / 5e5 = 2e9
    expect(BigInt(h1!.avg_cost_lamports)).toBe(2_000_000_000n);

    // Second buy stacks amount + invested, recomputes avg_cost.
    await recordBuy({
      tgId: 1001,
      mint: "MintA",
      symbol: "AAA",
      decimals: 6,
      solLamports: 3_000_000n,
      tokensReceived: 500_000n,
      feeLamports: 50_000n,
      txSignature: "sig-a-2",
    });
    const h2 = await getHolding(1001, "MintA");
    expect(h2?.amount).toBe("1000000");
    expect(BigInt(h2!.total_invested_lamports)).toBe(4_000_000n);
    // (4e6 * 1e9) / 1e6 = 4e9
    expect(BigInt(h2!.avg_cost_lamports)).toBe(4_000_000_000n);

    const all = await listHoldings(1001);
    expect(all.length).toBe(1);
  });

  it("recordSell debits and rejects oversell via row-level CHECK", async () => {
    const { recordBuy, recordSell, getHolding } = await import("./holdings.js");
    await recordBuy({
      tgId: 1002,
      mint: "MintB",
      symbol: "BBB",
      decimals: 9,
      solLamports: 500_000n,
      tokensReceived: 1_000n,
      feeLamports: 0n,
      txSignature: "sig-b-1",
    });

    await recordSell({
      tgId: 1002,
      mint: "MintB",
      symbol: "BBB",
      decimals: 9,
      tokensSold: 400n,
      solReceived: 250_000n,
      feeLamports: 0n,
      txSignature: "sig-b-2",
    });
    const after = await getHolding(1002, "MintB");
    expect(after?.amount).toBe("600");

    // Oversell rejects without mutating the row.
    await expect(
      recordSell({
        tgId: 1002,
        mint: "MintB",
        symbol: "BBB",
        decimals: 9,
        tokensSold: 10_000n,
        solReceived: 0n,
        feeLamports: 0n,
        txSignature: "sig-b-3",
      }),
    ).rejects.toThrow(/InsufficientTokenBalance/);
    const stillAt600 = await getHolding(1002, "MintB");
    expect(stillAt600?.amount).toBe("600");
  });
});
