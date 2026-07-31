// Contention threshold calibrator.
//
// Reads real evaluation + outcome history from the execution ledger and
// adapts each contract's HOLD threshold so the contention scanner's
// sensitivity tracks actual failure rates instead of a fixed constant.
// All DB access is delegated to ledger.ts — this module is pure policy.
import {
  getEntriesForContract,
  getThresholdRow,
  upsertThreshold,
} from "./ledger.js";

// ── Constants ───────────────────────────────────────────────────────────

/** Default hold threshold — also used when a contract has never been calibrated. */
export const DEFAULT_HOLD_THRESHOLD = 0.7;

const HOLD_THRESHOLD_MIN = 0.3; // never so sensitive it's unusable
const HOLD_THRESHOLD_MAX = 0.95; // never so strict it's impossible

const WINDOW_MINUTES = 60; // look-back window for calibration samples
const LOWER_AT_FAILURE_RATE = 0.4; // > 40% failures → make the scanner more sensitive
const RAISE_BELOW_FAILURE_RATE = 0.1; // < 10% failures → relax (only with enough samples)
const MIN_SAMPLES_TO_RAISE = 20; // don't relax on a tiny, noisy sample
const LOWER_FACTOR = 0.9; // −10%
const RAISE_FACTOR = 1.05; // +5%

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * The calibrated HOLD threshold for a contract, or the default 0.7 when no
 * calibration exists (or the ledger is unavailable). Never throws.
 */
export function getThreshold(contractAddress: string): number {
  try {
    if (!ADDRESS_RE.test(contractAddress)) return DEFAULT_HOLD_THRESHOLD;
    const row = getThresholdRow(contractAddress);
    return row !== null ? row.hold_threshold : DEFAULT_HOLD_THRESHOLD;
  } catch (err) {
    console.error(`[calibrator] getThreshold failed for "${contractAddress}":`, err);
    return DEFAULT_HOLD_THRESHOLD;
  }
}

/**
 * Re-derive a contract's hold threshold from its recent history (last 60 min):
 *   failure rate > 40%  → lower threshold by 10% (more sensitive)
 *   failure rate < 10%  → raise threshold by 5% (less sensitive), only when
 *                         more than MIN_SAMPLES_TO_RAISE samples exist
 * Clamped to [0.3, 0.95] so it can never become useless or impossibly strict.
 * Never throws — logs and gives up on any error.
 */
export function recalibrate(contractAddress: string): void {
  try {
    if (!ADDRESS_RE.test(contractAddress)) {
      console.error(`[calibrator] recalibrate: invalid address "${contractAddress}"`);
      return;
    }

    const entries = getEntriesForContract(contractAddress, WINDOW_MINUTES);
    const sampleCount = entries.length;

    if (sampleCount === 0) {
      console.log(`[calibrator] ${contractAddress}: no entries in ${WINDOW_MINUTES}min window — leaving threshold unchanged`);
      return;
    }

    const failures = entries.filter(
      (e) => e.outcome === "FAILED" || e.policy_action === "ABORT",
    ).length;
    const failureRate = failures / sampleCount;
    const current = getThreshold(contractAddress);

    let next = current;
    if (failureRate > LOWER_AT_FAILURE_RATE) {
      next = current * LOWER_FACTOR;
    } else if (failureRate < RAISE_BELOW_FAILURE_RATE && sampleCount > MIN_SAMPLES_TO_RAISE) {
      next = current * RAISE_FACTOR;
    }
    next = Math.min(HOLD_THRESHOLD_MAX, Math.max(HOLD_THRESHOLD_MIN, next));

    upsertThreshold(contractAddress, next, sampleCount);
    console.log(
      `[calibrator] ${contractAddress}: ${failures}/${sampleCount} failures (${(failureRate * 100).toFixed(1)}%) → hold_threshold ${current.toFixed(3)} → ${next.toFixed(3)}`,
    );
  } catch (err) {
    console.error(`[calibrator] recalibrate failed for "${contractAddress}":`, err);
  }
}
