CREATE TABLE parsed_event_reconciliation_jobs (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  window_started_at_utc TEXT NOT NULL,
  window_expires_at_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','RETRY_WAIT','COMPLETE','PARTIAL')),
  priority INTEGER NOT NULL DEFAULT 100,
  pagination_token TEXT,
  stopped_on TEXT,
  scanned_through_slot INTEGER,
  scanned_through_block_time INTEGER,
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  credits_charged INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_utc TEXT NOT NULL,
  reason_code TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  completed_at_utc TEXT,
  UNIQUE(mint, window_started_at_utc)
);
CREATE INDEX parsed_reconciliation_pending_idx
  ON parsed_event_reconciliation_jobs(status, priority, next_attempt_at_utc, created_at_utc);

CREATE TABLE parsed_event_reconciliation_transactions (
  job_id TEXT NOT NULL REFERENCES parsed_event_reconciliation_jobs(id),
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL,
  block_time INTEGER,
  status TEXT NOT NULL CHECK (status IN ('PENDING','VERIFIED','IRRELEVANT','UNSUPPORTED','FAILED')),
  reason_code TEXT,
  parsed_protocol TEXT,
  parsed_kind TEXT,
  parsed_mint TEXT,
  instruction_names_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_utc TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  provenance TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY(job_id, signature)
);
CREATE INDEX parsed_reconciliation_tx_pending_idx
  ON parsed_event_reconciliation_transactions(status, created_at_utc);

CREATE TABLE parsed_event_scan_budget (
  utc_day TEXT PRIMARY KEY,
  credits_charged INTEGER NOT NULL DEFAULT 0,
  credits_reserved INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  updated_at_utc TEXT NOT NULL
);
