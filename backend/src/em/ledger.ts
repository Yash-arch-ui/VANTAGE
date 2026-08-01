// Execution Memory — SQLite-backed audit ledger + per-contract calibration store.
//
// Every PSG/APA evaluation is persisted as an immutable row (the evidence
// backing every claim in the demo), and the contention calibrator reads/writes
// per-contract hold thresholds from here.
//
// Sync better-sqlite3 API is intentional: correctness and safety matter more
// than speed here, and every query is parameterized (? placeholders) so user
// data can never alter the SQL being executed.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { PSGForecast } from "../psg/forecast.js";
import type { PolicyResult } from "../apa/policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "schema.sql");

let db: Database.Database | null = null;

// ── Types ──────────────────────────────────────────────────────────────

export type ExecutionLedgerRow = {
  id: string;
  tx_from: string;
  tx_to: string;
  tx_data: string | null;
  tx_value: string | null;
  forecast_json: string;
  policy_action: string;
  policy_reason: string;
  explanation: string | null;
  user_action: string | null;
  outcome: string | null;
  tx_hash: string | null;
  created_at: string;
};

/**
 * A ledger row as the API exposes it: everything the audit timeline needs,
 * minus the heavyweight forecast_json blob, plus the riskLevel projected out
 * of it.
 */
export type LedgerListItem = {
  id: string;
  tx_from: string;
  tx_to: string;
  tx_value: string | null;
  policy_action: string;
  policy_reason: string;
  explanation: string | null;
  user_action: string | null;
  outcome: string | null;
  tx_hash: string | null;
  risk_level: string | null;
  created_at: string;
};

export type RecordEntryInput = {
  txFrom: string;
  txTo: string;
  txData: string;
  txValue: string;
  forecast: PSGForecast;
  policy: PolicyResult;
  explanation: string;
};

export type SessionStats = {
  total: number;
  byAction: Record<string, number>;
  byOutcome: Record<string, number>;
  overridden: number;
};

export type ThresholdRow = {
  contract_address: string;
  hold_threshold: number;
  sample_count: number;
  last_calibrated: string | null;
};

// ── Init ───────────────────────────────────────────────────────────────

/**
 * Open (or create) the SQLite file, enable WAL, and apply schema.sql — but
 * only when the ledger table does not already exist (checked via sqlite_master,
 * never a blind CREATE TABLE). Safe to call on every server start: existing
 * data is never wiped.
 */
export function initDatabase(dbPath: string): Database.Database {
  try {
    const database = new Database(dbPath);
    database.pragma("journal_mode = WAL");

    const hasTable = (name: string): boolean =>
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) !== undefined;

    // Run the schema when ANY core table is missing. Every statement in
    // schema.sql is CREATE ... IF NOT EXISTS, so this doubles as a safe,
    // idempotent migration: existing tables are left untouched, and missing
    // ones (e.g. the watchdog tables on a DB created before this module
    // landed) are created on the next server start. Never wipes data.
    if (!hasTable("execution_ledger") || !hasTable("watchlist")) {
      const schema = readFileSync(SCHEMA_PATH, "utf-8");
      database.exec(schema);
    }

    db = database;
    return database;
  } catch (err) {
    console.error(`[ledger] initDatabase failed for "${dbPath}":`, err);
    throw new Error(
      `ledger init failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── Inserts / updates ───────────────────────────────────────────────────

const INSERT_SQL = `
  INSERT INTO execution_ledger
    (id, tx_from, tx_to, tx_data, tx_value, forecast_json, policy_action,
     policy_reason, explanation, user_action, outcome, tx_hash, created_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
`;

/**
 * Persist one evaluation as an immutable audit row. Fully parameterized —
 * no field is ever concatenated into SQL. Returns the generated id (or null
 * if the ledger is unavailable / the write failed).
 */
export function recordEntry(entry: RecordEntryInput): string | null {
  if (!db) {
    console.error("[ledger] recordEntry called before initDatabase — returning null");
    return null;
  }
  try {
    const id = randomUUID();
    db.prepare(INSERT_SQL).run(
      id,
      entry.txFrom,
      entry.txTo,
      entry.txData,
      entry.txValue,
      JSON.stringify(entry.forecast),
      entry.policy.action,
      entry.policy.reason,
      entry.explanation,
      new Date().toISOString(), // server-side timestamp — never client-supplied
    );
    return id;
  } catch (err) {
    console.error("[ledger] recordEntry failed:", err);
    return null;
  }
}

const UPDATE_SQL = `
  UPDATE execution_ledger
  SET user_action = COALESCE(?, user_action),
      outcome      = COALESCE(?, outcome),
      tx_hash      = COALESCE(?, tx_hash)
  WHERE id = ?
`;

/**
 * Attach the post-submission outcome to one ledger row. Only the row with the
 * given id is touched; NULL fields leave the existing value in place.
 */
export function updateOutcome(
  id: string,
  userAction: string | null,
  outcome: string | null,
  txHash: string | null,
): void {
  if (!db) {
    console.error("[ledger] updateOutcome called before initDatabase — no-op");
    return;
  }
  try {
    db.prepare(UPDATE_SQL).run(userAction, outcome, txHash, id);
  } catch (err) {
    console.error(`[ledger] updateOutcome failed for id "${id}":`, err);
  }
}

// ── Queries ────────────────────────────────────────────────────────────

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Session-wide aggregates grouped by policy_action and outcome. Never throws:
 * returns zeroed values when the ledger is empty or unavailable.
 */
export function getSessionStats(): SessionStats {
  const zeros = (): SessionStats => ({ total: 0, byAction: {}, byOutcome: {}, overridden: 0 });
  if (!db) {
    console.error("[ledger] getSessionStats called before initDatabase — returning zeros");
    return zeros();
  }
  try {
    const totalRow = db.prepare("SELECT COUNT(*) AS c FROM execution_ledger").get() as { c: number };
    const byAction: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};

    for (const row of db
      .prepare("SELECT policy_action AS k, COUNT(*) AS c FROM execution_ledger GROUP BY policy_action")
      .all() as { k: string; c: number }[]) {
      byAction[row.k] = row.c;
    }

    for (const row of db
      .prepare("SELECT outcome AS k, COUNT(*) AS c FROM execution_ledger WHERE outcome IS NOT NULL GROUP BY outcome")
      .all() as { k: string; c: number }[]) {
      byOutcome[row.k] = row.c;
    }

    const overriddenRow = db
      .prepare("SELECT COUNT(*) AS c FROM execution_ledger WHERE user_action = 'OVERRIDDEN'")
      .get() as { c: number };

    return { total: totalRow.c, byAction, byOutcome, overridden: overriddenRow.c };
  } catch (err) {
    console.error("[ledger] getSessionStats failed:", err);
    return zeros();
  }
}

/**
 * All ledger rows for a contract within the given look-back window. The
 * address is validated as a plausible hex address first (defense in depth
 * even though the value originates from our own backend).
 */
export function getEntriesForContract(
  address: string,
  windowMinutes: number,
): ExecutionLedgerRow[] {
  if (!db) {
    console.error("[ledger] getEntriesForContract called before initDatabase — returning []");
    return [];
  }
  try {
    if (!ADDRESS_RE.test(address)) {
      console.error(`[ledger] getEntriesForContract: invalid address format "${address}"`);
      return [];
    }
    const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    return db
      .prepare(
        "SELECT * FROM execution_ledger WHERE tx_to = ? AND created_at >= ? ORDER BY created_at DESC",
      )
      .all(address, cutoff) as ExecutionLedgerRow[];
  } catch (err) {
    console.error(`[ledger] getEntriesForContract failed for "${address}":`, err);
    return [];
  }
}

/** Fetch one ledger row by id (used by the outcome route to recalibrate the right contract). */
export function getEntryById(id: string): ExecutionLedgerRow | null {
  if (!db) {
    console.error("[ledger] getEntryById called before initDatabase — returning null");
    return null;
  }
  try {
    const row = db.prepare("SELECT * FROM execution_ledger WHERE id = ?").get(id);
    return (row as ExecutionLedgerRow | undefined) ?? null;
  } catch (err) {
    console.error(`[ledger] getEntryById failed for id "${id}":`, err);
    return null;
  }
}

/**
 * All-time evaluation count for a contract — the "sample size" a trust score
 * is built on. Distinct from getEntriesForContract (time-windowed): a long
 * clean history should be visible even when nothing was evaluated recently.
 * The address is validated like every other contract query.
 */
export function countEvaluations(address: string): number {
  if (!db) {
    console.error("[ledger] countEvaluations called before initDatabase — returning 0");
    return 0;
  }
  try {
    if (!ADDRESS_RE.test(address)) {
      console.error(`[ledger] countEvaluations: invalid address format "${address}"`);
      return 0;
    }
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM execution_ledger WHERE tx_to = ?")
      .get(address) as { c: number };
    return row.c;
  } catch (err) {
    console.error(`[ledger] countEvaluations failed for "${address}":`, err);
    return 0;
  }
}

/**
 * Newest-first page of ledger rows, optionally narrowed to one contract.
 * `total` is the count matching the same filter (not the page), so a UI can
 * paginate without a second call.
 *
 * forecast_json is deliberately NOT returned — it is a multi-KB blob per row.
 * The one field a timeline needs from it (riskLevel) is projected out here.
 */
export function getRecentEntries(
  opts: { limit?: number; offset?: number; contract?: string } = {},
): { items: LedgerListItem[]; total: number } {
  const empty = { items: [] as LedgerListItem[], total: 0 };
  if (!db) {
    console.error("[ledger] getRecentEntries called before initDatabase — returning empty");
    return empty;
  }
  try {
    // Clamp rather than reject: a bad limit should degrade to a sane page,
    // not 500 a dashboard.
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 25)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    let contract: string | null = null;
    if (opts.contract !== undefined) {
      if (!ADDRESS_RE.test(opts.contract)) {
        console.error(`[ledger] getRecentEntries: invalid address format "${opts.contract}"`);
        return empty;
      }
      contract = opts.contract;
    }

    const where = contract ? "WHERE tx_to = ?" : "";
    const filterArgs = contract ? [contract] : [];

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS c FROM execution_ledger ${where}`)
      .get(...filterArgs) as { c: number };

    const rows = db
      .prepare(
        `SELECT id, tx_from, tx_to, tx_value, forecast_json, policy_action, policy_reason,
                explanation, user_action, outcome, tx_hash, created_at
         FROM execution_ledger ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...filterArgs, limit, offset) as (Omit<LedgerListItem, "risk_level"> & {
      forecast_json: string;
    })[];

    const items = rows.map(({ forecast_json, ...rest }) => ({
      ...rest,
      risk_level: parseRiskLevel(forecast_json),
    }));

    return { items, total: totalRow.c };
  } catch (err) {
    console.error("[ledger] getRecentEntries failed:", err);
    return empty;
  }
}

/**
 * Pull riskLevel out of a stored forecast blob. Rows written by older versions
 * (or a truncated write) must not break the whole page, so anything unparseable
 * yields null rather than throwing.
 */
function parseRiskLevel(forecastJson: string): string | null {
  try {
    const parsed = JSON.parse(forecastJson) as { riskLevel?: unknown };
    return typeof parsed.riskLevel === "string" ? parsed.riskLevel : null;
  } catch {
    return null;
  }
}

// ── Calibration store ───────────────────────────────────────────────────

/** Read the calibrated hold threshold for a contract, or null when never calibrated. */
export function getThresholdRow(contractAddress: string): ThresholdRow | null {
  if (!db) {
    console.error("[ledger] getThresholdRow called before initDatabase — returning null");
    return null;
  }
  try {
    const row = db
      .prepare(
        "SELECT contract_address, hold_threshold, sample_count, last_calibrated FROM contention_thresholds WHERE contract_address = ?",
      )
      .get(contractAddress);
    return (row as ThresholdRow | undefined) ?? null;
  } catch (err) {
    console.error(`[ledger] getThresholdRow failed for "${contractAddress}":`, err);
    return null;
  }
}

/** Insert or update a contract's calibrated threshold (parameterized upsert). */
export function upsertThreshold(
  contractAddress: string,
  holdThreshold: number,
  sampleCount: number,
): void {
  if (!db) {
    console.error("[ledger] upsertThreshold called before initDatabase — no-op");
    return;
  }
  try {
    db.prepare(
      `INSERT INTO contention_thresholds (contract_address, hold_threshold, sample_count, last_calibrated)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(contract_address) DO UPDATE SET
         hold_threshold = excluded.hold_threshold,
         sample_count   = excluded.sample_count,
         last_calibrated = excluded.last_calibrated`,
    ).run(contractAddress, holdThreshold, sampleCount, new Date().toISOString());
  } catch (err) {
    console.error(`[ledger] upsertThreshold failed for "${contractAddress}":`, err);
  }
}

// ── Watchdog: watchlist + alerts ────────────────────────────────────────

export type WatchlistRow = {
  contract_address: string;
  watch_type: string;
  added_at: string;
  last_checked: string | null;
};

export type AlertRow = {
  id: string;
  contract_address: string;
  type: string;
  severity: string;
  message: string;
  drift_pct: number | null;
  is_read: number;
  dismissed: number;
  created_at: string;
};

export type NewAlertInput = {
  contractAddress: string;
  type: string;
  severity: string;
  message: string;
  driftPct?: number | null;
};

export type AlertFilters = {
  unread?: boolean;
  severity?: string;
  address?: string;
  limit?: number;
};

export type AlertSummary = {
  total: number;
  unread: number;
  critical: number;
  bySeverity: Record<string, number>;
};

/** Add a contract to the watchlist. Idempotent (INSERT OR IGNORE). Returns true if newly added. */
export function addToWatchlist(address: string, watchType: string): boolean {
  if (!db) {
    console.error("[ledger] addToWatchlist called before initDatabase — returning false");
    return false;
  }
  try {
    if (!ADDRESS_RE.test(address)) {
      console.error(`[ledger] addToWatchlist: invalid address "${address}"`);
      return false;
    }
    const info = db
      .prepare(
        "INSERT OR IGNORE INTO watchlist (contract_address, watch_type, added_at) VALUES (?, ?, ?)",
      )
      .run(address, watchType, new Date().toISOString());
    return info.changes > 0;
  } catch (err) {
    console.error(`[ledger] addToWatchlist failed for "${address}":`, err);
    return false;
  }
}

/** Remove a contract from the watchlist. Alerts cascade-delete via the FK. */
export function removeFromWatchlist(address: string): boolean {
  if (!db) {
    console.error("[ledger] removeFromWatchlist called before initDatabase — returning false");
    return false;
  }
  try {
    const info = db.prepare("DELETE FROM watchlist WHERE contract_address = ?").run(address);
    return info.changes > 0;
  } catch (err) {
    console.error(`[ledger] removeFromWatchlist failed for "${address}":`, err);
    return false;
  }
}

/** All watched contracts, oldest first. */
export function getWatchlist(): WatchlistRow[] {
  if (!db) {
    console.error("[ledger] getWatchlist called before initDatabase — returning []");
    return [];
  }
  try {
    return db
      .prepare(
        "SELECT contract_address, watch_type, added_at, last_checked FROM watchlist ORDER BY added_at ASC",
      )
      .all() as WatchlistRow[];
  } catch (err) {
    console.error("[ledger] getWatchlist failed:", err);
    return [];
  }
}

/** Record the timestamp of a completed poll for a watched contract. */
export function setLastChecked(address: string, checkedAt: string): void {
  if (!db) {
    console.error("[ledger] setLastChecked called before initDatabase — no-op");
    return;
  }
  try {
    db.prepare("UPDATE watchlist SET last_checked = ? WHERE contract_address = ?").run(
      checkedAt,
      address,
    );
  } catch (err) {
    console.error(`[ledger] setLastChecked failed for "${address}":`, err);
  }
}

/**
 * Insert an alert. Deduplicates: if an undismissed alert of the same
 * (address, type) already exists, returns null instead of spamming rows every
 * poll cycle. Returns the new alert id (or null when deduped / failed).
 */
export function insertAlert(input: NewAlertInput): string | null {
  if (!db) {
    console.error("[ledger] insertAlert called before initDatabase — returning null");
    return null;
  }
  try {
    const active = db
      .prepare("SELECT id FROM alerts WHERE contract_address = ? AND type = ? AND dismissed = 0 LIMIT 1")
      .get(input.contractAddress, input.type);
    if (active !== undefined) return null;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO alerts (id, contract_address, type, severity, message, drift_pct, is_read, dismissed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    ).run(
      id,
      input.contractAddress,
      input.type,
      input.severity,
      input.message,
      input.driftPct ?? null,
      new Date().toISOString(),
    );
    return id;
  } catch (err) {
    console.error(`[ledger] insertAlert failed for ${input.contractAddress} ${input.type}:`, err);
    return null;
  }
}

/** True when an undismissed alert of this (address, type) is already present. */
export function hasActiveAlert(address: string, type: string): boolean {
  if (!db) {
    console.error("[ledger] hasActiveAlert called before initDatabase — returning false");
    return false;
  }
  try {
    const row = db
      .prepare("SELECT id FROM alerts WHERE contract_address = ? AND type = ? AND dismissed = 0 LIMIT 1")
      .get(address, type);
    return row !== undefined;
  } catch (err) {
    console.error(`[ledger] hasActiveAlert failed for ${address} ${type}:`, err);
    return false;
  }
}

/** Count of active (undismissed) critical alerts for a contract — used by the APA bias. */
export function getActiveCriticalAlertCount(address: string): number {
  if (!db) {
    console.error("[ledger] getActiveCriticalAlertCount called before initDatabase — returning 0");
    return 0;
  }
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM alerts WHERE contract_address = ? AND severity = 'critical' AND dismissed = 0",
      )
      .get(address) as { c: number };
    return row.c;
  } catch (err) {
    console.error(`[ledger] getActiveCriticalAlertCount failed for "${address}":`, err);
    return 0;
  }
}

/** List alerts with optional filters (address, severity, unread-only, limit). */
export function getAlerts(filters: AlertFilters = {}): AlertRow[] {
  if (!db) {
    console.error("[ledger] getAlerts called before initDatabase — returning []");
    return [];
  }
  try {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters.address !== undefined) {
      if (!ADDRESS_RE.test(filters.address)) {
        console.error(`[ledger] getAlerts: invalid address "${filters.address}"`);
        return [];
      }
      where.push("contract_address = ?");
      params.push(filters.address);
    }
    if (filters.severity !== undefined) {
      where.push("severity = ?");
      params.push(filters.severity);
    }
    // Dismissed alerts are hidden from every list view by default — a dismissed
    // alert is removed from the queue, never deleted (the row stays in the DB).
    where.push("dismissed = 0");
    if (filters.unread === true) {
      where.push("is_read = 0");
    }

    const limit = filters.limit !== undefined ? Math.min(Math.max(1, filters.limit), 100) : 100;
    params.push(limit);

    const sql = `SELECT * FROM alerts${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
    return db.prepare(sql).all(...params) as AlertRow[];
  } catch (err) {
    console.error("[ledger] getAlerts failed:", err);
    return [];
  }
}

/** Toggle read / dismissed on one alert. Returns true if a row was updated. */
export function updateAlert(
  id: string,
  patch: { read?: boolean; dismissed?: boolean },
): boolean {
  if (!db) {
    console.error("[ledger] updateAlert called before initDatabase — returning false");
    return false;
  }
  try {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.read !== undefined) {
      sets.push("is_read = ?");
      params.push(patch.read ? 1 : 0);
    }
    if (patch.dismissed !== undefined) {
      sets.push("dismissed = ?");
      params.push(patch.dismissed ? 1 : 0);
    }
    if (sets.length === 0) return false;
    params.push(id);
    const info = db
      .prepare(`UPDATE alerts SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return info.changes > 0;
  } catch (err) {
    console.error(`[ledger] updateAlert failed for id "${id}":`, err);
    return false;
  }
}

/** Unread / critical / per-severity counts over all alerts. Never throws. */
export function getAlertSummary(): AlertSummary {
  const zeros = (): AlertSummary => ({ total: 0, unread: 0, critical: 0, bySeverity: {} });
  if (!db) {
    console.error("[ledger] getAlertSummary called before initDatabase — returning zeros");
    return zeros();
  }
  try {
    const total = (db.prepare("SELECT COUNT(*) AS c FROM alerts").get() as { c: number }).c;
    const unread = (
      db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE is_read = 0 AND dismissed = 0").get() as { c: number }
    ).c;
    const critical = (
      db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE severity = 'critical' AND dismissed = 0").get() as { c: number }
    ).c;
    const bySeverity: Record<string, number> = {};
    for (const row of db
      .prepare("SELECT severity AS k, COUNT(*) AS c FROM alerts GROUP BY severity")
      .all() as { k: string; c: number }[]) {
      bySeverity[row.k] = row.c;
    }
    return { total, unread, critical, bySeverity };
  } catch (err) {
    console.error("[ledger] getAlertSummary failed:", err);
    return zeros();
  }
}
