/**
 * Minimal pool interface the rest of the code depends on. Both
 * node-postgres `pg.Pool` and our pglite adapter satisfy it. The bot
 * never touches anything richer than this — keep it that way so the
 * dual-backend story stays trivial.
 */

// `any` for the row type default — node-postgres returns untyped rows
// and the rest of the codebase reads columns by name without explicit
// shapes. Callers that want type-safe rows can pass the generic
// argument; everything else stays unchanged.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface QueryResult<R = any> {
  rows: R[];
  rowCount: number;
}

export interface DbClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  release(): void;
}

export interface DbPool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  connect(): Promise<DbClient>;
  end(): Promise<void>;
}
