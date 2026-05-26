/**
 * pglite-backed Pool that satisfies the DbPool interface.
 *
 * pglite is an in-process WASM Postgres. Same SQL dialect, no Docker,
 * no system Postgres. Default storage is a directory under
 * ~/.stealth-trader/db so multiple bot starts persist state.
 *
 * Transactions: pglite has a single in-process connection, so the
 * `connect()` shim returns a Client that issues BEGIN/COMMIT/ROLLBACK
 * on the shared instance. Concurrent transactions on different `Client`
 * instances would interleave their BEGINs — the bot serializes per-user
 * operations via src/userLock.ts, so this is acceptable for the OSS
 * default. Production deployments should use the Postgres path.
 */
import { PGlite } from "@electric-sql/pglite";
import type { DbClient, DbPool, QueryResult } from "./types.js";

class PgliteClient implements DbClient {
  constructor(private db: PGlite) {}
  async query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
    const r = await this.db.query<R>(sql, params ?? []);
    const rows = r.rows ?? [];
    // pglite sets affectedRows for INSERT/UPDATE/DELETE but leaves it 0 for
    // SELECT (where pg would report the row count). `??` won't fall through
    // on 0, so use max(rows, affected): SELECT → rows.length, write → affected.
    const rowCount = Math.max(rows.length, r.affectedRows ?? 0);
    return { rows, rowCount };
  }
  release(): void { /* nothing to release — single in-process connection */ }
}

class PglitePool implements DbPool {
  constructor(private db: PGlite) {}
  async query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
    const r = await this.db.query<R>(sql, params ?? []);
    const rows = r.rows ?? [];
    // pglite sets affectedRows for INSERT/UPDATE/DELETE but leaves it 0 for
    // SELECT (where pg would report the row count). `??` won't fall through
    // on 0, so use max(rows, affected): SELECT → rows.length, write → affected.
    const rowCount = Math.max(rows.length, r.affectedRows ?? 0);
    return { rows, rowCount };
  }
  async connect(): Promise<DbClient> {
    return new PgliteClient(this.db);
  }
  async end(): Promise<void> {
    await this.db.close();
  }
}

export async function makePglitePool(dataDir: string): Promise<DbPool> {
  const db = new PGlite({ dataDir });
  await db.waitReady;
  return new PglitePool(db);
}
