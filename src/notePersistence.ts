/**
 * Postgres-backed adapter for @b402ai/solana's NoteStore pluggable
 * persistence interface. One row per viewing-pub. The SDK serializes
 * single-threaded per user; one stealth-trader process owns each
 * viewing-pub at a time, so last-write-wins is correct.
 *
 * The SDK round-trips an opaque JSON string. We persist it as JSONB
 * (validated by JSON.parse on save) and rehydrate on load.
 */
import type { DbPool } from "./db/index.js";

export interface NotePersistence {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

export function makeNotePersistence(pool: DbPool, viewingPubHex: string): NotePersistence {
  return {
    async load(): Promise<string | null> {
      const r = await pool.query(
        `SELECT snapshot FROM stealth.note_store_state WHERE viewing_pub_hex = $1`,
        [viewingPubHex],
      );
      if (r.rows.length === 0) return null;
      const snap = r.rows[0].snapshot;
      if (snap == null) return null;
      return typeof snap === "string" ? snap : JSON.stringify(snap);
    },

    async save(data: string): Promise<void> {
      // Validate parseability before hitting the DB so we don't fill the
      // table with corrupt blobs.
      const parsed = JSON.parse(data);
      await pool.query(
        `INSERT INTO stealth.note_store_state (viewing_pub_hex, snapshot, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (viewing_pub_hex)
         DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = NOW()`,
        [viewingPubHex, parsed],
      );
    },
  };
}
