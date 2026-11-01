CREATE TABLE IF NOT EXISTS wallet_token_outflows (
  id TEXT PRIMARY KEY,
  wallet_pubkey TEXT NOT NULL,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  before_amount_raw TEXT NOT NULL CHECK (length(before_amount_raw) > 0 AND before_amount_raw NOT GLOB '*[^0-9]*'),
  after_amount_raw TEXT NOT NULL CHECK (length(after_amount_raw) > 0 AND after_amount_raw NOT GLOB '*[^0-9]*'),
  observed_at_utc TEXT,
  reason_code TEXT NOT NULL,
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  UNIQUE(wallet_pubkey, mint, signature, reason_code)
);
CREATE INDEX IF NOT EXISTS wallet_token_outflows_asof_idx
  ON wallet_token_outflows(wallet_pubkey, slot);

CREATE TABLE IF NOT EXISTS launch_trade_observations (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER,
  block_time_utc TEXT,
  received_at_utc TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  trader_wallet TEXT,
  token_amount_raw TEXT,
  quote_amount_raw TEXT,
  venue TEXT NOT NULL CHECK (venue IN ('PUMP_BONDING_CURVE', 'PUMPSWAP', 'UNKNOWN')),
  source TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  UNIQUE(mint, signature)
);
CREATE INDEX IF NOT EXISTS launch_trade_mint_time_idx
  ON launch_trade_observations(mint, received_at_utc, slot);

CREATE TABLE IF NOT EXISTS launch_behavior_snapshots (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  window_seconds INTEGER NOT NULL CHECK (window_seconds IN (30, 60, 120)),
  observed_at_utc TEXT NOT NULL,
  through_slot INTEGER,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  gap_reason TEXT,
  snapshot_json TEXT NOT NULL,
  UNIQUE(mint, window_seconds, observed_at_utc)
);
CREATE INDEX IF NOT EXISTS launch_behavior_mint_time_idx
  ON launch_behavior_snapshots(mint, observed_at_utc);

CREATE TABLE IF NOT EXISTS market_quotes (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  venue TEXT,
  snapshot_slot INTEGER,
  observed_at_utc TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('PASS', 'FAIL', 'UNKNOWN')),
  quote_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_quotes_mint_time_idx
  ON market_quotes(mint, observed_at_utc);

CREATE TABLE IF NOT EXISTS external_request_budget (
  provider TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  requests_used INTEGER NOT NULL CHECK (requests_used >= 0),
  PRIMARY KEY(provider, utc_day)
);
