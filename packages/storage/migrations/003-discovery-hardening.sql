ALTER TABLE tokens ADD COLUMN launch_initiator TEXT;
ALTER TABLE tokens ADD COLUMN migration_slot INTEGER;
ALTER TABLE provider_health ADD COLUMN connection_state TEXT;
ALTER TABLE provider_health ADD COLUMN last_message_at_utc TEXT;
ALTER TABLE provider_health ADD COLUMN last_processed_at_utc TEXT;
ALTER TABLE provider_health ADD COLUMN processing_lag_ms INTEGER;
ALTER TABLE provider_health ADD COLUMN queue_depth INTEGER NOT NULL DEFAULT 0;

UPDATE tokens SET created_slot = (
  SELECT MIN(slot) FROM market_events
  WHERE market_events.mint = tokens.mint AND kind = 'TOKEN_CREATED' AND slot IS NOT NULL
);
UPDATE tokens SET migration_slot = (
  SELECT MIN(slot) FROM market_events
  WHERE market_events.mint = tokens.mint AND kind = 'TOKEN_MIGRATED' AND slot IS NOT NULL
);

CREATE TABLE IF NOT EXISTS helius_request_budget (
  utc_day TEXT PRIMARY KEY,
  requests_used INTEGER NOT NULL CHECK (requests_used >= 0)
);

CREATE TABLE IF NOT EXISTS enrichment_jobs (
  event_id TEXT PRIMARY KEY REFERENCES market_events(id),
  mint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED', 'DEFERRED_BUDGET')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at_utc TEXT NOT NULL,
  last_error_code TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS enrichment_jobs_pending_idx ON enrichment_jobs(status, next_attempt_at_utc, created_at_utc);

CREATE TABLE IF NOT EXISTS stream_gaps (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  disconnected_at_utc TEXT NOT NULL,
  reconnected_at_utc TEXT,
  reconciliation_state TEXT NOT NULL CHECK (reconciliation_state IN ('OPEN', 'UNRECOVERED')),
  error_code TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_checkpoints (
  provider TEXT PRIMARY KEY,
  last_slot INTEGER,
  last_signature TEXT,
  last_event_id TEXT,
  updated_at_utc TEXT NOT NULL
);
