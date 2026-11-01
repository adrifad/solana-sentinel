CREATE TABLE launch_trade_observations_v2 (
  id TEXT PRIMARY KEY,
  event_index INTEGER NOT NULL DEFAULT 0 CHECK (event_index >= 0),
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
  UNIQUE(mint, signature, event_index)
);
INSERT INTO launch_trade_observations_v2
  (id, event_index, mint, signature, slot, block_time_utc, received_at_utc, side,
   trader_wallet, token_amount_raw, quote_amount_raw, venue, source, payload_ref)
SELECT id, 0, mint, signature, slot, block_time_utc, received_at_utc, side,
       trader_wallet, token_amount_raw, quote_amount_raw, venue, source, payload_ref
FROM launch_trade_observations;
DROP TABLE launch_trade_observations;
ALTER TABLE launch_trade_observations_v2 RENAME TO launch_trade_observations;
CREATE INDEX launch_trade_mint_time_idx
  ON launch_trade_observations(mint, received_at_utc, slot);

ALTER TABLE paper_positions ADD COLUMN opened_at_utc TEXT;
UPDATE paper_positions SET opened_at_utc = updated_at_utc WHERE opened_at_utc IS NULL;

CREATE TABLE trade_observation_coverage (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETE', 'PARTIAL', 'GAP_DETECTED', 'RECONCILING', 'UNVERIFIED')),
  window_started_at_utc TEXT NOT NULL,
  window_expires_at_utc TEXT NOT NULL,
  last_event_at_utc TEXT,
  reconnect_count INTEGER NOT NULL DEFAULT 0 CHECK (reconnect_count >= 0),
  reason_code TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  UNIQUE(mint, source, window_started_at_utc)
);
CREATE INDEX trade_coverage_mint_updated_idx
  ON trade_observation_coverage(mint, updated_at_utc DESC);

CREATE TABLE trade_event_budget (
  provider TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  events_used INTEGER NOT NULL CHECK (events_used >= 0),
  PRIMARY KEY(provider, utc_day)
);

CREATE TABLE paper_position_monitor_state (
  wallet_id TEXT NOT NULL REFERENCES paper_accounts(wallet_id),
  mint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'UNPRICEABLE', 'EXIT_BLOCKED', 'EXIT_PENDING', 'CLOSED')),
  reason_code TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at_utc TEXT,
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY(wallet_id, mint)
);

CREATE TABLE analysis_stage_timings (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES market_events(id),
  mint TEXT NOT NULL,
  stage TEXT NOT NULL,
  started_at_utc TEXT NOT NULL,
  finished_at_utc TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
);
CREATE INDEX analysis_stage_timings_stage_time_idx
  ON analysis_stage_timings(stage, finished_at_utc);
