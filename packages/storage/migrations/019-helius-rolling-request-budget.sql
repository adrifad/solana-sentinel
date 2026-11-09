CREATE TABLE helius_rpc_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at_ms INTEGER NOT NULL,
  utc_day TEXT NOT NULL,
  method TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (
    priority IN ('EXIT', 'RISK', 'CANDIDATE', 'SECURITY', 'CREATOR', 'BACKGROUND')
  ),
  component TEXT NOT NULL,
  purpose TEXT NOT NULL,
  subject_mint TEXT
);

CREATE INDEX helius_rpc_attempts_window_idx
  ON helius_rpc_attempts(observed_at_ms, priority);
