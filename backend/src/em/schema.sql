-- Execution Memory (EM) schema — immutable audit ledger + per-contract calibration.
-- Idempotent: every statement is CREATE ... IF NOT EXISTS, so this file is safe to
-- run on every server start without wiping existing data.

CREATE TABLE IF NOT EXISTS execution_ledger (
  id              TEXT PRIMARY KEY,     -- uuid (crypto.randomUUID)
  tx_from         TEXT NOT NULL,
  tx_to           TEXT NOT NULL,
  tx_data         TEXT,
  tx_value        TEXT,
  forecast_json   TEXT NOT NULL,        -- full PSGForecast serialized
  policy_action   TEXT NOT NULL,        -- PROCEED/WARN/HOLD_AND_RECHECK/SUGGEST_ADJUSTMENT/ABORT
  policy_reason   TEXT NOT NULL,
  explanation     TEXT,
  user_action     TEXT,                 -- SIGNED/CANCELLED/OVERRIDDEN (nullable until known)
  outcome         TEXT,                 -- CONFIRMED/FAILED/DROPPED/STUCK (nullable until known)
  tx_hash         TEXT,
  created_at      TEXT NOT NULL         -- ISO 8601, set server-side only
);

CREATE TABLE IF NOT EXISTS contention_thresholds (
  contract_address   TEXT PRIMARY KEY,
  hold_threshold      REAL NOT NULL DEFAULT 0.7,
  sample_count        INTEGER NOT NULL DEFAULT 0,
  last_calibrated     TEXT
);

-- Both are queried frequently: per-contract calibration (tx_to) and session
-- stats over a time window (created_at).
CREATE INDEX IF NOT EXISTS idx_execution_ledger_tx_to ON execution_ledger(tx_to);
CREATE INDEX IF NOT EXISTS idx_execution_ledger_created_at ON execution_ledger(created_at);
