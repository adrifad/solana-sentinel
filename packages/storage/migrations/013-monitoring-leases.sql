ALTER TABLE tokens ADD COLUMN monitoring_lease_until_utc TEXT;
UPDATE tokens
SET monitoring_lease_until_utc = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+120 seconds')
WHERE monitoring_eligible = 1;

CREATE TABLE helius_rpc_request_history (
  id INTEGER PRIMARY KEY,
  utc_day TEXT NOT NULL,
  method TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('EXIT', 'RISK', 'CANDIDATE', 'SECURITY', 'CREATOR', 'BACKGROUND')),
  component TEXT NOT NULL,
  purpose TEXT NOT NULL,
  subject_mint TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED', 'BUDGET_BLOCKED')),
  error_code TEXT,
  observed_at_utc TEXT NOT NULL
);
CREATE INDEX helius_rpc_history_day_idx ON helius_rpc_request_history(utc_day, method, priority);
