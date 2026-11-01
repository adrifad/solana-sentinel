CREATE TABLE IF NOT EXISTS market_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'pumpportal'),
  kind TEXT NOT NULL CHECK (kind IN ('TOKEN_CREATED', 'TOKEN_MIGRATED')),
  mint TEXT NOT NULL,
  signature TEXT,
  slot INTEGER,
  observed_at_utc TEXT,
  received_at_utc TEXT NOT NULL,
  first_seen_at_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  sanitized_payload TEXT NOT NULL CHECK (length(sanitized_payload) <= 4096),
  ingestion_latency_ms REAL NOT NULL CHECK (ingestion_latency_ms >= 0),
  UNIQUE(provider, idempotency_key)
);

CREATE INDEX IF NOT EXISTS market_events_mint_slot_idx ON market_events(mint, slot);
CREATE INDEX IF NOT EXISTS market_events_received_idx ON market_events(received_at_utc);

CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  first_seen_at_utc TEXT NOT NULL,
  last_seen_at_utc TEXT NOT NULL,
  created_slot INTEGER,
  creator TEXT,
  market_phase TEXT NOT NULL CHECK (market_phase IN ('PUMP_CURVE', 'MIGRATED_UNKNOWN_VENUE')),
  name TEXT,
  symbol TEXT,
  uri TEXT,
  monitoring_eligible INTEGER NOT NULL CHECK (monitoring_eligible IN (0, 1)),
  event_count INTEGER NOT NULL CHECK (event_count > 0)
);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  checked_at_utc TEXT,
  last_event_at_utc TEXT,
  reconnect_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);
