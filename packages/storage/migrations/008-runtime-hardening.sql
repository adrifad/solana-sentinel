ALTER TABLE market_events ADD COLUMN provider_slot INTEGER;
UPDATE market_events SET provider_slot = slot WHERE provider_slot IS NULL;

CREATE TABLE IF NOT EXISTS migration_recovery_jobs (
  event_id TEXT PRIMARY KEY REFERENCES market_events(id),
  mint TEXT NOT NULL,
  signature TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  resolved_slot INTEGER CHECK (resolved_slot IS NULL OR resolved_slot >= 0),
  error_code TEXT,
  next_attempt_at_utc TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS migration_recovery_pending_idx
  ON migration_recovery_jobs(status, next_attempt_at_utc, created_at_utc);

CREATE TABLE IF NOT EXISTS migration_analysis_jobs (
  event_id TEXT PRIMARY KEY REFERENCES market_events(id),
  mint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETE')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at_utc TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS migration_analysis_pending_idx
  ON migration_analysis_jobs(status, next_attempt_at_utc, created_at_utc);

INSERT OR IGNORE INTO migration_recovery_jobs
  (event_id, mint, signature, status, next_attempt_at_utc, created_at_utc, updated_at_utc)
SELECT e.id, e.mint, e.signature, 'PENDING', e.received_at_utc, e.received_at_utc, e.received_at_utc
FROM market_events e WHERE e.kind = 'TOKEN_MIGRATED';

UPDATE tokens SET migration_slot = NULL
WHERE mint IN (SELECT mint FROM migration_recovery_jobs WHERE status = 'PENDING');

UPDATE tokens SET
  creator = CASE WHEN EXISTS (
    SELECT 1 FROM wallet_role_evidence r WHERE r.mint = tokens.mint
      AND r.role = 'CLAIMED_CREATOR' AND r.source = 'PUMP_IDL_CREATE_EVENT'
      AND r.confidence_bps = 10000
  ) THEN creator ELSE NULL END,
  launch_initiator = CASE WHEN EXISTS (
    SELECT 1 FROM wallet_role_evidence r WHERE r.mint = tokens.mint
      AND r.role = 'LAUNCH_INITIATOR' AND r.source = 'PUMP_IDL_CREATE_EVENT'
      AND r.confidence_bps = 10000
  ) THEN launch_initiator ELSE NULL END
WHERE mint IN (SELECT mint FROM market_events WHERE kind = 'TOKEN_MIGRATED');

CREATE TABLE IF NOT EXISTS provider_frame_diagnostics (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('PROVIDER_ERROR', 'PROVIDER_CONTROL', 'UNSUPPORTED_FRAME', 'MALFORMED_FRAME')),
  reason_code TEXT NOT NULL,
  sanitized_payload TEXT NOT NULL CHECK (length(sanitized_payload) <= 4096),
  observed_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_frame_diagnostics_time_idx
  ON provider_frame_diagnostics(provider, observed_at_utc);
