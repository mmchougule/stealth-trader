-- stealth-trader: user balances + deposit ledger.
-- Apply on top of 001_init.sql.

-- Each Telegram user has a derived Solana keypair (managed by the SDK)
-- and a public SOL balance the bot debits when copy-trading.
-- The keypair is derived from a per-deploy master seed + tg_id; we
-- only persist the public side here so the bot can address it without
-- re-derivation on every read.
ALTER TABLE stealth.users
  ADD COLUMN IF NOT EXISTS solana_pubkey         TEXT,
  ADD COLUMN IF NOT EXISTS sol_balance_lamports  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS users_solana_pubkey ON stealth.users (solana_pubkey)
  WHERE solana_pubkey IS NOT NULL;

-- Audit trail of every credit/debit on a user's SOL balance.
-- Reasons: deposit, buy, buy_fee, buy_refund, cashout, sell_credit, manual.
CREATE TABLE IF NOT EXISTS stealth.balance_ledger (
  id              BIGSERIAL PRIMARY KEY,
  tg_id           BIGINT NOT NULL REFERENCES stealth.users(tg_id),
  delta_lamports  BIGINT NOT NULL,
  reason          TEXT NOT NULL,
  tx_signature    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS balance_ledger_tg_created ON stealth.balance_ledger (tg_id, created_at DESC);
