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

    const existing = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("execution_ledger");

    if (!existing) {
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
