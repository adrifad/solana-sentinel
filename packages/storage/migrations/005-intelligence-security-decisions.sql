CREATE TABLE IF NOT EXISTS analysis_jobs (
  event_id TEXT PRIMARY KEY REFERENCES market_events(id),
  mint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETE')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at_utc TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analysis_jobs_pending_idx ON analysis_jobs(status, next_attempt_at_utc, created_at_utc);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  wallet_pubkey TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  block_time_seconds INTEGER,
  fetched_at_utc TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  fee_lamports_raw TEXT NOT NULL,
  provenance TEXT NOT NULL,
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  reason_code TEXT NOT NULL,
  sanitized_transaction_json TEXT NOT NULL CHECK (length(sanitized_transaction_json) <= 32768),
  PRIMARY KEY(wallet_pubkey, signature)
);
CREATE INDEX IF NOT EXISTS wallet_transactions_asof_idx ON wallet_transactions(wallet_pubkey, slot, signature);

CREATE TABLE IF NOT EXISTS wallet_role_evidence (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  wallet_pubkey TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('CLAIMED_CREATOR', 'LAUNCH_INITIATOR', 'FEE_PAYER', 'MINT_AUTHORITY', 'FREEZE_AUTHORITY', 'FUNDING_SOURCE')),
  source TEXT NOT NULL,
  signature TEXT,
  slot INTEGER,
  observed_at_utc TEXT NOT NULL,
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  reason_code TEXT NOT NULL,
  UNIQUE(mint, wallet_pubkey, role, source, signature, reason_code)
);
CREATE INDEX IF NOT EXISTS wallet_role_evidence_mint_idx ON wallet_role_evidence(mint, role, slot);

CREATE TABLE IF NOT EXISTS creator_launches (
  creator_pubkey TEXT NOT NULL,
  mint TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  block_time_seconds INTEGER,
  observed_at_utc TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  idl_revision TEXT NOT NULL,
  PRIMARY KEY(creator_pubkey, mint, signature)
);
CREATE INDEX IF NOT EXISTS creator_launches_asof_idx ON creator_launches(creator_pubkey, slot);

CREATE TABLE IF NOT EXISTS wallet_links (
  id TEXT PRIMARY KEY,
  source_wallet TEXT NOT NULL,
  destination_wallet TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('DIRECT_FUNDING', 'REPEATED_COSIGNER')),
  evidence_signature TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  observed_at_utc TEXT NOT NULL,
  amount_lamports_raw TEXT,
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  reason_code TEXT NOT NULL,
  UNIQUE(source_wallet, destination_wallet, relation_type, evidence_signature, reason_code)
);
CREATE INDEX IF NOT EXISTS wallet_links_source_idx ON wallet_links(source_wallet, relation_type, confidence_bps);
CREATE INDEX IF NOT EXISTS wallet_links_destination_idx ON wallet_links(destination_wallet, relation_type, confidence_bps);

CREATE TABLE IF NOT EXISTS wallet_history_refresh (
  wallet_pubkey TEXT NOT NULL,
  as_of_slot INTEGER NOT NULL CHECK (as_of_slot >= 0),
  next_before_signature TEXT,
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  history_complete INTEGER NOT NULL DEFAULT 0 CHECK (history_complete IN (0, 1)),
  last_fetched_at_utc TEXT NOT NULL,
  fresh_until_utc TEXT NOT NULL,
  last_error_code TEXT,
  PRIMARY KEY(wallet_pubkey, as_of_slot)
);

CREATE TABLE IF NOT EXISTS creator_reputation (
  wallet_pubkey TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('KNOWN', 'SUSPICIOUS', 'UNKNOWN')),
  launches_observed INTEGER NOT NULL CHECK (launches_observed >= 0),
  suspicious_indicators_json TEXT NOT NULL,
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  history_complete INTEGER NOT NULL CHECK (history_complete IN (0, 1)),
  as_of_slot INTEGER,
  computed_at_utc TEXT NOT NULL,
  fresh_until_utc TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS creator_reputation_history (
  wallet_pubkey TEXT NOT NULL,
  as_of_slot INTEGER NOT NULL CHECK (as_of_slot >= 0),
  report_json TEXT NOT NULL,
  PRIMARY KEY(wallet_pubkey, as_of_slot)
);

CREATE TABLE IF NOT EXISTS token_security_reports (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  as_of_slot INTEGER,
  observed_at_utc TEXT NOT NULL,
  report_json TEXT NOT NULL,
  UNIQUE(mint, id)
);
CREATE INDEX IF NOT EXISTS token_security_reports_mint_idx ON token_security_reports(mint, observed_at_utc);

CREATE TABLE IF NOT EXISTS risk_decisions (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('REJECT', 'QUARANTINE', 'WATCH', 'BUY_ELIGIBLE')),
  config_version TEXT NOT NULL,
  security_report_id TEXT NOT NULL REFERENCES token_security_reports(id),
  reason_codes_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  decided_at_utc TEXT NOT NULL,
  latency_ms REAL NOT NULL CHECK (latency_ms >= 0),
  UNIQUE(mint, id)
);
CREATE INDEX IF NOT EXISTS risk_decisions_mint_idx ON risk_decisions(mint, decided_at_utc);

CREATE TABLE IF NOT EXISTS dry_run_trade_intents (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode = 'DRY_RUN'),
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  decision_id TEXT NOT NULL REFERENCES risk_decisions(id),
  reason_codes_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

INSERT OR IGNORE INTO analysis_jobs(event_id, mint, status, next_attempt_at_utc, created_at_utc, updated_at_utc)
SELECT id, mint, 'PENDING', received_at_utc, received_at_utc, received_at_utc
FROM market_events JOIN tokens USING(mint)
WHERE kind = 'TOKEN_CREATED';
