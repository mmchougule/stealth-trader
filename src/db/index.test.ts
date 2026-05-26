/**
 * q() + withTx() shims, exercised against an isolated pglite instance.
 *
 * Two shapes of withTx are tested:
 *   - withTx(pool, fn): explicit pool (matches existing callers)
 *   - withTx(fn):       auto-resolves the singleton pool
 *
 * The auto-resolve path is exercised by setting DATABASE_URL to a unique
 * pglite path BEFORE first getPool(), then calling withTx(fn) and q()
 * with no pool arg. Each test file gets its own pglite dir so we never
 * collide with the user's real ~/.stealth-trader/db.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makePglitePool } from "./pglite-pool.js";

describe("db helpers", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stealth-db-test-"));
    // Point the singleton at a throw-away pglite. getPool() reads this
    // exactly once and caches, so set it BEFORE the first import-side
    // effect that calls getPool().
    process.env.DATABASE_URL = `pglite:${tmpDir}`;
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
  });

  it("withTx(pool, fn) commits on success and rolls back on throw", async () => {
    const pool = await makePglitePool(tmpDir);
    await pool.query("CREATE SCHEMA IF NOT EXISTS t1");
    await pool.query("CREATE TABLE IF NOT EXISTS t1.kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    const { withTx } = await import("./index.js");

    await withTx(pool, async (c) => {
      await c.query("INSERT INTO t1.kv (k, v) VALUES ($1, $2)", ["a", 1]);
    });
    const ok = await pool.query<{ v: number }>("SELECT v FROM t1.kv WHERE k = $1", ["a"]);
    expect(ok.rows[0]?.v).toBe(1);

    await expect(
      withTx(pool, async (c) => {
        await c.query("INSERT INTO t1.kv (k, v) VALUES ($1, $2)", ["b", 2]);
        throw new Error("rollback me");
      }),
    ).rejects.toThrow("rollback me");
    const after = await pool.query<{ v: number }>("SELECT v FROM t1.kv WHERE k = $1", ["b"]);
    expect(after.rowCount).toBe(0);
  });

  it("q() and withTx(fn) auto-resolve the singleton pool", async () => {
    const { q, withTx } = await import("./index.js");

    await q("CREATE SCHEMA IF NOT EXISTS t2");
    await q("CREATE TABLE IF NOT EXISTS t2.kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");

    await withTx(async (c) => {
      await c.query("INSERT INTO t2.kv (k, v) VALUES ($1, $2)", ["x", 42]);
    });

    const r = await q<{ v: number }>("SELECT v FROM t2.kv WHERE k = $1", ["x"]);
    expect(r.rows[0]?.v).toBe(42);
  });

  it("SELECT reports rowCount = rows.length (pglite affectedRows=0 regression)", async () => {
    // pglite returns affectedRows=0 for SELECT; the adapter must fall back
    // to rows.length or callers that guard `if (rowCount === 0) return`
    // (deposit watcher) and `rowCount > 0 ? ... : 0` (/balance) silently
    // see zero rows. This bug shipped once and broke deposits + balance.
    const { q } = await import("./index.js");
    await q("CREATE SCHEMA IF NOT EXISTS t3");
    await q("CREATE TABLE IF NOT EXISTS t3.kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    await q("INSERT INTO t3.kv (k, v) VALUES ('a', 1), ('b', 2), ('c', 3)");
    const sel = await q<{ v: number }>("SELECT v FROM t3.kv");
    expect(sel.rows.length).toBe(3);
    expect(sel.rowCount).toBe(3); // must NOT be 0
    const empty = await q("SELECT v FROM t3.kv WHERE k = 'nope'");
    expect(empty.rowCount).toBe(0);
  });
});
