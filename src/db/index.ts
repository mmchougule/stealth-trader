/**
 * Postgres pool + thin query helpers.
 *
 * Connection comes from DATABASE_URL. The bot expects the schema in
 * sql/001_init.sql to be applied — `pnpm setup` runs it.
 */
import pg from "pg";

let _pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required. Copy .env.example to .env and fill it in.");
  }
  _pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  _pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[db] idle client error:", err.message);
  });
  return _pool;
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}
