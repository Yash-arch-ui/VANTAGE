-- Execution Memory (EM) schema — immutable audit ledger + per-contract calibration.
-- Idempotent: every statement is CREATE ... IF NOT EXISTS, so this file is safe to
-- run on every server start without wiping existing data.

CREATE TABLE IF NOT EXISTS execution_ledger (
  id              TEXT PRIMARY KEY,     -- uuid (crypto.randomUUID)
  tx_from         TEXT NOT NULL COLLATE NOCASE,
  tx_to           TEXT NOT NULL COLLATE NOCASE,
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
  contract_address   TEXT PRIMARY KEY COLLATE NOCASE,
  hold_threshold      REAL NOT NULL DEFAULT 0.7,
  sample_count        INTEGER NOT NULL DEFAULT 0,
  last_calibrated     TEXT
);

-- Both are queried frequently: per-contract calibration (tx_to) and session
-- stats over a time window (created_at).
CREATE INDEX IF NOT EXISTS idx_execution_ledger_tx_to ON execution_ledger(tx_to);
CREATE INDEX IF NOT EXISTS idx_execution_ledger_created_at ON execution_ledger(created_at);

-- ── Watchdog: watchlist + alerts ────────────────────────────────────────

-- Contracts the watchdog polls. watch_type distinguishes user-added ('manual')
-- from contracts auto-added after an /api/evaluate call ('auto').
CREATE TABLE IF NOT EXISTS watchlist (
  contract_address TEXT PRIMARY KEY COLLATE NOCASE,
  watch_type        TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'auto'
  added_at          TEXT NOT NULL,                    -- ISO 8601, server-side
  last_checked      TEXT                              -- ISO 8601 of last successful poll
);

-- Alerts raised by the watchdog. type is one of:
--   reserve_drift | contention_spike | failure_surge | approval_exposure | inactivity
CREATE TABLE IF NOT EXISTS alerts (
  id                TEXT PRIMARY KEY,
  contract_address  TEXT NOT NULL COLLATE NOCASE,
  type              TEXT NOT NULL,
  severity          TEXT NOT NULL,                    -- info | warning | critical
  message           TEXT NOT NULL,
  drift_pct         REAL,                             -- populated for reserve_drift
  is_read           INTEGER NOT NULL DEFAULT 0,       -- 0/1
  dismissed         INTEGER NOT NULL DEFAULT 0,       -- 0/1
  created_at        TEXT NOT NULL,                    -- ISO 8601
  FOREIGN KEY (contract_address) REFERENCES watchlist(contract_address) ON DELETE CASCADE
);

-- Queried frequently: per-address alert listing and the unread/dismissed views.
CREATE INDEX IF NOT EXISTS idx_alerts_contract_address ON alerts(contract_address);
CREATE INDEX IF NOT EXISTS idx_alerts_read_dismissed ON alerts(is_read, dismissed);
