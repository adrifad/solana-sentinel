ALTER TABLE market_events ADD COLUMN observed_time_source TEXT;

ALTER TABLE tokens ADD COLUMN mint_state_status TEXT NOT NULL DEFAULT 'UNKNOWN'
  CHECK (mint_state_status IN ('UNKNOWN', 'PRESENT', 'NOT_FOUND', 'PROVIDER_ERROR'));
ALTER TABLE tokens ADD COLUMN mint_account_slot INTEGER;
ALTER TABLE tokens ADD COLUMN mint_program_id TEXT;
ALTER TABLE tokens ADD COLUMN mint_state_error_code TEXT;
