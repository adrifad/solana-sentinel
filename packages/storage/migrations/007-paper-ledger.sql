CREATE TABLE IF NOT EXISTS paper_accounts (
  wallet_id TEXT PRIMARY KEY,
  initial_sol_lamports TEXT NOT NULL CHECK (length(initial_sol_lamports) > 0 AND initial_sol_lamports NOT GLOB '*[^0-9]*'),
  created_at_utc TEXT NOT NULL,
  UNIQUE(wallet_id, created_at_utc)
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES paper_accounts(wallet_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  input_amount_raw TEXT NOT NULL CHECK (length(input_amount_raw) > 0 AND input_amount_raw NOT GLOB '*[^0-9]*'),
  intent_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SIMULATED_FILLED', 'REJECTED', 'UNFILLABLE', 'EXPIRED')),
  reason_code TEXT,
  created_at_utc TEXT NOT NULL,
  arrival_at_utc TEXT,
  completed_at_utc TEXT
);

CREATE TABLE IF NOT EXISTS paper_journals (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES paper_accounts(wallet_id),
  order_id TEXT REFERENCES paper_orders(id),
  journal_type TEXT NOT NULL CHECK (journal_type IN ('OPENING_BALANCE', 'TRADE_FILL')),
  created_at_utc TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_ledger_entries (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES paper_journals(id),
  wallet_id TEXT NOT NULL REFERENCES paper_accounts(wallet_id),
  account TEXT NOT NULL,
  asset_mint TEXT NOT NULL,
  delta_raw TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  UNIQUE(journal_id, account, asset_mint)
);
CREATE INDEX IF NOT EXISTS paper_ledger_wallet_asset_idx
  ON paper_ledger_entries(wallet_id, asset_mint, account, created_at_utc);

CREATE TABLE IF NOT EXISTS paper_fills (
  order_id TEXT PRIMARY KEY REFERENCES paper_orders(id),
  wallet_id TEXT NOT NULL REFERENCES paper_accounts(wallet_id),
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  input_amount_raw TEXT NOT NULL CHECK (length(input_amount_raw) > 0 AND input_amount_raw NOT GLOB '*[^0-9]*'),
  output_amount_raw TEXT NOT NULL CHECK (length(output_amount_raw) > 0 AND output_amount_raw NOT GLOB '*[^0-9]*'),
  venue_fee_raw TEXT NOT NULL CHECK (length(venue_fee_raw) > 0 AND venue_fee_raw NOT GLOB '*[^0-9]*'),
  network_fee_lamports TEXT NOT NULL CHECK (length(network_fee_lamports) > 0 AND network_fee_lamports NOT GLOB '*[^0-9]*'),
  extra_slippage_bps INTEGER NOT NULL CHECK (extra_slippage_bps BETWEEN 0 AND 10000),
  quote_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  snapshot_slot INTEGER NOT NULL,
  snapshot_at_utc TEXT NOT NULL,
  arrival_at_utc TEXT NOT NULL,
  filled_at_utc TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_positions (
  wallet_id TEXT NOT NULL REFERENCES paper_accounts(wallet_id),
  mint TEXT NOT NULL,
  token_amount_raw TEXT NOT NULL CHECK (length(token_amount_raw) > 0 AND token_amount_raw NOT GLOB '*[^0-9]*'),
  cost_basis_lamports TEXT NOT NULL CHECK (length(cost_basis_lamports) > 0 AND cost_basis_lamports NOT GLOB '*[^0-9]*'),
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY(wallet_id, mint)
);

CREATE TABLE IF NOT EXISTS paper_realized_pnl (
  order_id TEXT PRIMARY KEY REFERENCES paper_fills(order_id),
  wallet_id TEXT NOT NULL REFERENCES paper_accounts(wallet_id),
  mint TEXT NOT NULL,
  pnl_lamports TEXT NOT NULL,
  filled_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_realized_day_idx
  ON paper_realized_pnl(wallet_id, filled_at_utc);

CREATE TABLE IF NOT EXISTS paper_equity_marks (
  wallet_id TEXT NOT NULL REFERENCES paper_accounts(wallet_id),
  marked_at_utc TEXT NOT NULL,
  equity_lamports TEXT NOT NULL CHECK (length(equity_lamports) > 0 AND equity_lamports NOT GLOB '*[^0-9]*'),
  peak_equity_lamports TEXT NOT NULL CHECK (length(peak_equity_lamports) > 0 AND peak_equity_lamports NOT GLOB '*[^0-9]*'),
  drawdown_bps INTEGER NOT NULL CHECK (drawdown_bps BETWEEN 0 AND 10000),
  unpriceable_positions INTEGER NOT NULL CHECK (unpriceable_positions >= 0),
  PRIMARY KEY(wallet_id, marked_at_utc)
);
CREATE INDEX IF NOT EXISTS paper_equity_latest_idx
  ON paper_equity_marks(wallet_id, marked_at_utc DESC);

