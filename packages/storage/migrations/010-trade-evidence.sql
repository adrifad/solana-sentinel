ALTER TABLE launch_trade_observations ADD COLUMN event_time_utc TEXT;
ALTER TABLE launch_trade_observations ADD COLUMN event_time_source TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE launch_trade_observations ADD COLUMN ingested_at_utc TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE launch_trade_observations ADD COLUMN quote_mint TEXT;
ALTER TABLE launch_trade_observations ADD COLUMN decoder_version TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE launch_trade_observations ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE launch_trade_observations ADD COLUMN validation_confidence_bps INTEGER NOT NULL DEFAULT 0;

UPDATE launch_trade_observations
SET ingested_at_utc = received_at_utc
WHERE ingested_at_utc = '1970-01-01T00:00:00.000Z';

CREATE INDEX launch_trade_validation_mint_idx
  ON launch_trade_observations(mint, validation_status, slot);
