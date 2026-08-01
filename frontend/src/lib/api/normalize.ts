// snake_case SQLite rows -> camelCase app types.
//
// The /watchlist, /alerts and /ledger endpoints return database rows verbatim,
// including 0|1 integers where the app wants booleans. Converting here once
// means no component ever branches on `is_read === 1`.
import type {
  Alert,
  LedgerEntry,
  WatchlistItem,
  WireAlert,
  WireLedgerEntry,
  WireWatchlistItem,
} from "./types";

/** SQLite has no boolean type; these columns are stored as 0 or 1. */
const toBool = (v: 0 | 1 | boolean): boolean => v === true || v === 1;

export function normalizeWatchlistItem(row: WireWatchlistItem): WatchlistItem {
  return {
    address: row.contract_address,
    watchType: row.watch_type,
    addedAt: row.added_at,
    lastChecked: row.last_checked,
  };
}

export function normalizeAlert(row: WireAlert): Alert {
  return {
    id: row.id,
    address: row.contract_address,
    type: row.type,
    severity: row.severity,
    message: row.message,
    driftPct: row.drift_pct,
    isRead: toBool(row.is_read),
    dismissed: toBool(row.dismissed),
    createdAt: row.created_at,
  };
}

export function normalizeLedgerEntry(row: WireLedgerEntry): LedgerEntry {
  return {
    id: row.id,
    from: row.tx_from,
    to: row.tx_to,
    value: row.tx_value,
    action: row.policy_action,
    reason: row.policy_reason,
    explanation: row.explanation,
    userAction: row.user_action,
    outcome: row.outcome,
    txHash: row.tx_hash,
    riskLevel: row.risk_level,
    createdAt: row.created_at,
  };
}
