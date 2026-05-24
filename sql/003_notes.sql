-- stealth-trader: per-user NoteStore persistence for @b402ai/solana's
-- pluggable persistence interface. One row per viewing-pub.
--
-- The bot owns each viewing-pub at a time (single writer), so we don't
-- need a version column. Last-write-wins.

CREATE TABLE IF NOT EXISTS stealth.note_store_state (
  viewing_pub_hex  TEXT PRIMARY KEY,
  snapshot         JSONB NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS note_store_state_updated_at ON stealth.note_store_state (updated_at DESC);
