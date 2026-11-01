ALTER TABLE paper_orders ADD COLUMN entry_source TEXT NOT NULL DEFAULT 'AUTOMATIC'
  CHECK (entry_source IN ('AUTOMATIC', 'MANUAL'));

CREATE TABLE manual_paper_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_type TEXT NOT NULL CHECK (request_type IN ('ENTRY', 'EXIT')),
  wallet_id TEXT NOT NULL REFERENCES paper_accounts(wallet_id),
  mint TEXT NOT NULL,
  position_id TEXT,
  requested_amount_raw TEXT NOT NULL CHECK (length(requested_amount_raw) > 0 AND requested_amount_raw NOT GLOB '*[^0-9]*'),
  requested_size_sol TEXT,
  entry_source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (entry_source = 'MANUAL'),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'FILLED', 'REJECTED', 'UNFILLABLE')),
  reason_code TEXT,
  original_coverage_status TEXT,
  coverage_exception_reason TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  execution_order_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at_utc TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  claimed_at_utc TEXT,
  completed_at_utc TEXT
);
CREATE INDEX manual_paper_requests_wallet_status_idx
  ON manual_paper_requests(wallet_id, status, created_at_utc);
CREATE UNIQUE INDEX manual_paper_one_active_entry_idx
  ON manual_paper_requests(wallet_id)
  WHERE request_type = 'ENTRY' AND status IN ('PENDING', 'PROCESSING');
CREATE UNIQUE INDEX manual_paper_one_active_exit_idx
  ON manual_paper_requests(wallet_id, position_id)
  WHERE request_type = 'EXIT' AND status IN ('PENDING', 'PROCESSING');

CREATE TABLE paper_position_marks (
  wallet_id TEXT NOT NULL REFERENCES paper_accounts(wallet_id),
  mint TEXT NOT NULL,
  marked_at_utc TEXT NOT NULL,
  sell_quote_id TEXT NOT NULL,
  sell_value_lamports TEXT NOT NULL CHECK (length(sell_value_lamports) > 0 AND sell_value_lamports NOT GLOB '*[^0-9]*'),
  unrealized_pnl_lamports TEXT NOT NULL,
  snapshot_slot INTEGER NOT NULL,
  PRIMARY KEY(wallet_id, mint, marked_at_utc)
);
CREATE INDEX paper_position_marks_latest_idx
  ON paper_position_marks(wallet_id, mint, marked_at_utc DESC);
