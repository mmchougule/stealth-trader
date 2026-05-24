/**
 * Pool factory. Returns a DbPool backed by either node-postgres or
 * pglite, picked from DATABASE_URL:
 *
 *   postgresql://…           — node-postgres against a real cluster
 *   pglite:/path/to/data     — pglite with persistent file storage
 *   (unset)                  — pglite default at ~/.stealth-trader/db
 *
 * The factory caches a single pool per process. Callers do not need to
 * pass the URL — the factory reads `process.env.DATABASE_URL` (already
 * loaded by `dotenv/config` from the bot entrypoint).
 *
 * applySchema() runs sql/001..003 on first boot so a stranger never has
 * to `psql -f`. Idempotent — `CREATE TABLE IF NOT EXISTS` everywhere.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { makePglitePool } from "./pglite-pool.js";
import type { DbClient, DbPool } from "./types.js";

let _pool: Promise<DbPool> | undefined;

function poolErrorLogger(err: Error): void {
  // eslint-disable-next-line no-console
  console.error("[db] idle client error:", err.message);
}

class PgPoolAdapter implements DbPool {
  constructor(private pool: pg.Pool) {
    pool.on("error", poolErrorLogger);
  }
  async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
    const r = await this.pool.query(sql, params);
    return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
  }
  async connect(): Promise<DbClient> {
    const c = await this.pool.connect();
    return {
      async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
        const r = await c.query(sql, params);
        return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
      },
      release: () => c.release(),
    };
  }
  async end() { await this.pool.end(); }
}

function defaultPgliteDir(): string {
  const dir = path.join(os.homedir(), ".stealth-trader", "db");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function buildPool(): Promise<DbPool> {
  const url = process.env.DATABASE_URL;
  if (!url || url.startsWith("pglite:")) {
    const dataDir = url ? url.slice("pglite:".length) : defaultPgliteDir();
    // eslint-disable-next-line no-console
    console.log(`[db] pglite at ${dataDir}`);
    return makePglitePool(dataDir);
  }
  // eslint-disable-next-line no-console
  console.log(`[db] postgresql ${maskUrl(url)}`);
  const pgPool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return new PgPoolAdapter(pgPool);
}

export function getPool(): Promise<DbPool> {
  if (_pool) return _pool;
  _pool = buildPool();
  return _pool;
}

/**
 * One-shot schema apply. Runs sql/001..003 in order. Each migration
 * uses CREATE … IF NOT EXISTS so re-running is a no-op. Called from
 * the bot entrypoint AND the setup wizard so a stranger never has to
 * touch psql.
 */
export async function applySchema(pool: DbPool, sqlDir: string): Promise<void> {
  for (const f of ["001_init.sql", "002_balances.sql", "003_notes.sql"]) {
    const file = path.join(sqlDir, f);
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, "utf8");
    await pool.query(sql);
  }
}

/** withTx: run `fn` inside BEGIN/COMMIT, ROLLBACK on throw. Works on both
 *  the Postgres and pglite backends. */
export async function withTx<T>(pool: DbPool, fn: (c: DbClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}

function maskUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}

export type { DbPool, DbClient } from "./types.js";
