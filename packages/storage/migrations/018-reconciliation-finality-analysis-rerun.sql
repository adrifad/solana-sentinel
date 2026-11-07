ALTER TABLE analysis_jobs ADD COLUMN rerun_requested INTEGER NOT NULL DEFAULT 0
  CHECK (rerun_requested IN (0, 1));
ALTER TABLE migration_analysis_jobs ADD COLUMN rerun_requested INTEGER NOT NULL DEFAULT 0
  CHECK (rerun_requested IN (0, 1));

CREATE TABLE analysis_requeue_triggers (
  event_id TEXT NOT NULL REFERENCES market_events(id),
  trigger_key TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY(event_id, trigger_key)
);

ALTER TABLE parsed_event_reconciliation_jobs ADD COLUMN finality_ready_at_utc TEXT;
ALTER TABLE parsed_event_reconciliation_jobs ADD COLUMN finality_buffer_seconds INTEGER;
ALTER TABLE parsed_event_reconciliation_transactions
  ADD COLUMN expected_side TEXT CHECK (expected_side IN ('BUY', 'SELL') OR expected_side IS NULL);

-- Previous COMPLETE records did not retain proof that the configured finality
-- delay elapsed. Keep their history, but require a fresh verified scan.
UPDATE parsed_event_reconciliation_jobs
SET status = 'PARTIAL', reason_code = 'FINALITY_BOUNDARY_NOT_VERIFIED',
    completed_at_utc = NULL, updated_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'COMPLETE' AND finality_ready_at_utc IS NULL;

UPDATE trade_observation_coverage
SET status = 'PARTIAL', reason_code = 'FINALITY_BOUNDARY_NOT_VERIFIED',
    updated_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source = 'helius_parsed_events_scan' AND status = 'COMPLETE'
  AND EXISTS (
    SELECT 1 FROM parsed_event_reconciliation_jobs j
    WHERE j.mint = trade_observation_coverage.mint
      AND j.window_started_at_utc = trade_observation_coverage.window_started_at_utc
      AND j.status = 'PARTIAL'
      AND j.reason_code = 'FINALITY_BOUNDARY_NOT_VERIFIED'
  );
