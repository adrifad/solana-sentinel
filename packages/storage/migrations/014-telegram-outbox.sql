CREATE TABLE telegram_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at_utc TEXT NOT NULL,
  claimed_by TEXT,
  lease_until_utc TEXT,
  created_at_utc TEXT NOT NULL,
  sent_at_utc TEXT,
  last_error_code TEXT
);
CREATE INDEX telegram_outbox_delivery_idx
  ON telegram_outbox(status, available_at_utc, lease_until_utc, created_at_utc);

CREATE TABLE telegram_bot_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE telegram_consumer_leases (
  bot_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_until_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE telegram_alert_cooldowns (
  alert_key TEXT PRIMARY KEY,
  allowed_after_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
