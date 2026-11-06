CREATE TABLE paper_entry_evaluations (
  evaluation_key TEXT PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES tokens(mint),
  decision_id TEXT,
  decision_status TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('NOT_ATTEMPTED', 'SKIPPED', 'EVALUATING', 'ORDER_SUBMITTED', 'FILLED', 'REJECTED', 'UNFILLABLE')
  ),
  reason_code TEXT,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  evaluated_at_utc TEXT NOT NULL,
  evaluation_count INTEGER NOT NULL DEFAULT 1 CHECK (evaluation_count >= 1),
  order_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (order_attempt_count >= 0),
  execution_order_id TEXT,
  order_status TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX paper_entry_evaluations_mint_idx
  ON paper_entry_evaluations(mint, evaluated_at_utc DESC);
CREATE INDEX paper_entry_evaluations_status_idx
  ON paper_entry_evaluations(status, evaluated_at_utc DESC);
