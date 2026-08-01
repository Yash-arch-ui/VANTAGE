// Vantage Score — a live 0-100 trust score per contract.
//
// Pure aggregation, no detection logic: it only re-weights data the system
// already collects in Execution Memory (execution_ledger) and the Watchdog
// (alerts). Deterministic and explainable — every breakdown field maps to a
// fixed deduction below.
//
//   score = 100
//           − 40   × failureRate            (24h ledger: FAILED outcome or ABORT policy)
//           − min(30, alertCount)           (active undismissed alerts: crit 15 / warn 5 / info 1)
//           − 15   × contentionStability    (recent contention: 0..1)
//           − 15   flat when sampleSize < 5 (too little history to be confident)
//   clamped to [0, 100].
//
// A contract with zero evaluations is NOT scored at all (`scored: false`) —
// "not yet scored" is a distinct answer, never a numeric 100. An unscored
// contract is not the same as a proven-safe one.
import {
  getEntriesForContract,
  getAlerts,
  countEvaluations,
} from "../em/ledger.js";

// ── Weights (kept together so the score formula reads off one place) ───

const FAILURE_RATE_WINDOW_MINUTES = 24 * 60; // recent failures = last 24h
const FAILURE_WEIGHT = 40; // 100% failure rate → −40 points (proportional)
const ALERT_CRITICAL = 15; // a critical alert is worth more than a warning
const ALERT_WARNING = 5;
const ALERT_INFO = 1;
const ALERT_CAP = 30; // alerts can never outweigh the failure component
const CONTENTION_WEIGHT = 15; // contention 1.0 → −15 points
const MIN_SAMPLE_SIZE = 5; // below this, the flat confidence penalty applies
const SAMPLE_PENALTY = 15;

// ── Types ──────────────────────────────────────────────────────────────

export type ScoreBreakdown = {
  /** Fraction of 24h evaluations that failed (0..1). Deduction = failureRate × 40. */
  failureRate: number;
  /** Weighted active alert load (15×critical + 5×warning + 1×info). Deduction = min(30, alertCount). */
  alertCount: number;
  /** Recent contention (0..1) — highest contention observed; 0 = stable. Deduction = × 15. */
  contentionStability: number;
  /** Total evaluations ever recorded for this contract. Below 5 → flat −15. */
  sampleSize: number;
};

export type ScoredResult = {
  scored: true;
  score: number;
  breakdown: ScoreBreakdown;
  lastUpdated: string;
};

export type UnscoredResult = {
  scored: false;
  score: null;
  breakdown: ScoreBreakdown;
  lastUpdated: string;
  /** Stable marker — the consumer can branch on this instead of sniffing `score`. */
  message: "not yet scored";
};

export type ScoreResult = ScoredResult | UnscoredResult;

// ── Helpers ────────────────────────────────────────────────────────────

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Highest contentionScore the contract has shown across its recent evaluations,
 * read from the persisted forecast_json — the contention data we already
 * collect. Never recomputes a scan; if no row carries a numeric score, the
 * contract is treated as stable (0). A malformed row is skipped, not fatal.
 */
function persistedContention(entries: ReturnType<typeof getEntriesForContract>): number {
  let max = 0;
  for (const entry of entries) {
    try {
      const forecast = JSON.parse(entry.forecast_json) as { contentionScore?: number | null };
      const c = forecast.contentionScore;
      if (typeof c === "number" && Number.isFinite(c) && c > max) {
        max = c;
      }
    } catch {
      // Malformed forecast_json — ignore this row, keep scanning.
    }
  }
  return max;
}

// ── The score ──────────────────────────────────────────────────────────

/**
 * Compute the Vantage Score for one contract.
 *
 * @param contentionScore Optional already-computed contention (0..1). The
 *   /api/evaluate path passes the forecast's own contention score — reusing
 *   what that request already fetched, never re-scanning the chain. When
 *   omitted, the score reads the contract's persisted recent contention from
 *   its evaluation history instead.
 */
export function computeScore(
  contractAddress: string,
  contentionScore?: number | null,
): ScoreResult {
  const lastUpdated = new Date().toISOString();

  const recent = getEntriesForContract(contractAddress, FAILURE_RATE_WINDOW_MINUTES);
  const sampleSize = countEvaluations(contractAddress);

  const breakdown = (overrides: Partial<ScoreBreakdown> = {}): ScoreBreakdown => ({
    failureRate: 0,
    alertCount: 0,
    contentionStability: 0,
    sampleSize: 0,
    ...overrides,
  });

  // Never evaluated → "not yet scored", never a numeric 100.
  if (sampleSize === 0) {
    return {
      scored: false,
      score: null,
      breakdown: breakdown({ sampleSize }),
      lastUpdated,
      message: "not yet scored",
    };
  }

  // 1. Recent failure rate (24h) — the biggest, most signal-rich component.
  const failures = recent.filter(
    (e) => e.outcome === "FAILED" || e.policy_action === "ABORT",
  ).length;
  const failureRate = recent.length > 0 ? failures / recent.length : 0;

  // 2. Active (undismissed) alerts — critical weighs more than warning.
  const alertCount = getAlerts({ address: contractAddress }).reduce((acc, alert) => {
    switch (alert.severity) {
      case "critical":
        return acc + ALERT_CRITICAL;
      case "warning":
        return acc + ALERT_WARNING;
      default:
        return acc + ALERT_INFO;
    }
  }, 0);

  // 3. Contention — reuse the passed-in score when the caller has one,
  //    otherwise the persisted recent contention from evaluation history.
  const contentionStability =
    typeof contentionScore === "number" && Number.isFinite(contentionScore)
      ? clamp01(contentionScore)
      : persistedContention(recent);

  // 4. Confidence penalty for a thin history.
  const samplePenalty = sampleSize < MIN_SAMPLE_SIZE ? SAMPLE_PENALTY : 0;

  const raw =
    100 -
    FAILURE_WEIGHT * failureRate -
    Math.min(ALERT_CAP, alertCount) -
    CONTENTION_WEIGHT * contentionStability -
    samplePenalty;

  const score = Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;

  return {
    scored: true,
    score,
    breakdown: breakdown({
      failureRate: Math.round(failureRate * 10_000) / 10_000,
      alertCount,
      contentionStability: Math.round(contentionStability * 10_000) / 10_000,
      sampleSize,
    }),
    lastUpdated,
  };
}
