-- stealth-trader: initial schema
-- Run via `psql $DATABASE_URL -f sql/001_init.sql` or `pnpm setup` boots it.

CREATE SCHEMA IF NOT EXISTS stealth;

-- Telegram users authorized to use the bot. AUTHORIZED_TG_USERS env is the
-- source of truth at boot; this table is a write-through cache for joins.
CREATE TABLE IF NOT EXISTS stealth.users (
  tg_id           BIGINT PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Follow rows: a Telegram user follows a Solana leader wallet, with a
-- chosen per-trade size. Each leader buy triggers one copy at this size,
-- regardless of the leader's actual amount.
CREATE TABLE IF NOT EXISTS stealth.follows (
  id                    BIGSERIAL PRIMARY KEY,
  follower_tg           BIGINT NOT NULL REFERENCES stealth.users(tg_id),
  leader_wallet         TEXT NOT NULL,
  per_trade_lamports    BIGINT NOT NULL CHECK (per_trade_lamports >= 1000000),
  daily_budget_lamports BIGINT NOT NULL,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  min_copy_lamports     BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (follower_tg, leader_wallet),
  CHECK (daily_budget_lamports >= per_trade_lamports)
);

CREATE INDEX IF NOT EXISTS follows_leader_active ON stealth.follows (leader_wallet) WHERE active;

-- One row per webhook event we processed for a (follow, leader_sig) pair.
-- Status reflects what the bot did, not what the leader did.
CREATE TABLE IF NOT EXISTS stealth.copy_trades_log (
  id              BIGSERIAL PRIMARY KEY,
  follow_id       BIGINT NOT NULL REFERENCES stealth.follows(id),
  leader_sig      TEXT NOT NULL,
  follower_sig    TEXT,
  mint            TEXT NOT NULL,
  amount_lamports BIGINT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('success', 'skipped', 'failed')),
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (follow_id, leader_sig)
);

CREATE INDEX IF NOT EXISTS copy_log_follow_created ON stealth.copy_trades_log (follow_id, created_at DESC);

-- Singleton config rows for things the bot persists across restarts
-- (e.g. Helius webhook ID, so we don't create duplicate webhooks per deploy).
CREATE TABLE IF NOT EXISTS stealth.system_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
