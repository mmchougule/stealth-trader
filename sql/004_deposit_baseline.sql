-- 004: add last_seen_deposit_balance_lamports baseline for the
-- delta-balance deposit watcher (deposits.ts). Replaces the old
-- per-tx-signature approach which had idempotency bugs.
ALTER TABLE stealth.users
  ADD COLUMN IF NOT EXISTS last_seen_deposit_balance_lamports BIGINT NOT NULL DEFAULT 0;
