-- Per-user holdings ledger + trade history.
-- The b402 shielded pool reports one commingled balance owned by the
-- relayer; this table is the source of truth for who-owns-what + each
-- mint's running cost basis so /holdings can render PnL.

CREATE TABLE IF NOT EXISTS stealth.holdings (
  tg_id BIGINT NOT NULL,
  mint TEXT NOT NULL,
  amount NUMERIC(40, 0) NOT NULL DEFAULT 0,
  decimals INTEGER NOT NULL,
  symbol TEXT,
  avg_cost_lamports BIGINT NOT NULL DEFAULT 0,
  total_invested_lamports BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tg_id, mint),
  CONSTRAINT amount_nonneg CHECK (amount >= 0)
);

CREATE INDEX IF NOT EXISTS holdings_tg_idx ON stealth.holdings(tg_id);

CREATE TABLE IF NOT EXISTS stealth.trades (
  id BIGSERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  mint TEXT NOT NULL,
  symbol TEXT,
  sol_lamports BIGINT NOT NULL,
  token_amount NUMERIC(40, 0) NOT NULL,
  token_decimals INTEGER NOT NULL,
  fee_lamports BIGINT NOT NULL DEFAULT 0,
  tx_signature TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trades_tg_idx ON stealth.trades(tg_id, created_at DESC);
