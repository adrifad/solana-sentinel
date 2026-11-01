ALTER TABLE market_events ADD COLUMN chain_time_status TEXT NOT NULL DEFAULT 'UNKNOWN'
  CHECK (chain_time_status IN ('UNKNOWN', 'RESOLVED', 'UNAVAILABLE', 'PROVIDER_ERROR'));
ALTER TABLE market_events ADD COLUMN chain_time_error_code TEXT;

CREATE TABLE IF NOT EXISTS provider_event_conflicts (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES market_events(id),
  incoming_payload_ref TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  detected_at_utc TEXT NOT NULL,
  UNIQUE(event_id, incoming_payload_ref, reason_codes)
);

CREATE TABLE IF NOT EXISTS provider_issue_counters (
  provider TEXT NOT NULL,
  error_code TEXT NOT NULL,
  first_seen_at_utc TEXT NOT NULL,
  last_seen_at_utc TEXT NOT NULL,
  occurrences INTEGER NOT NULL CHECK (occurrences > 0),
  PRIMARY KEY(provider, error_code)
);
