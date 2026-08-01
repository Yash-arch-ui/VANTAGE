// Wire types, transcribed from the backend route handlers.
//
// Two casings arrive from the API: /evaluate, /stats, /score and /watch return
// camelCase, while /watchlist, /alerts and /ledger return raw snake_case SQLite
// rows with 0|1 integers for booleans. The Wire* types below describe what the
// server actually sends; normalize.ts converts them to the camelCase types the
// rest of the app uses, so no component ever sees `is_read`.

export type PolicyAction = "PROCEED" | "WARN" | "HOLD_AND_RECHECK" | "SUGGEST_ADJUSTMENT" | "ABORT";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Every flag the forecast can raise. Rendered as chips in the verdict panel. */
export type ForecastFlag =
  | "REVERT"
  | "STALE_STATE"
  | "LOW_BALANCE"
  | "NONCE_STALE"
  | "NONCE_GAP"
  | "HIGH_CONTENTION"
  | "WATCHDOG_CRITICAL_ALERTS";

export type ScoreBreakdown = {
  /** 0..1 — share of recent evaluations that ended in a failed transaction. */
  failureRate: number;
  /** Weighted alert count: 15x critical + 5x warning + 1x info. */
  alertCount: number;
  /** 0..1 — how contended the contract has been. */
  contentionStability: number;
  /** Total evaluations ever recorded for this contract. */
  sampleSize: number;
};

/**
 * Branch on `scored`, never on `score`: a contract that has never been
 * evaluated returns 200 with scored:false, which is a legitimate answer and
 * not an error.
 */
export type ScoreResult =
  | {
      scored: true;
      score: number;
      breakdown: ScoreBreakdown;
      lastUpdated: string;
    }
  | {
      scored: false;
      score: null;
      breakdown: ScoreBreakdown;
      lastUpdated: string;
      message?: string;
    };

export type Forecast = {
  simulationSuccess: boolean;
  revertReason: string | null;
  /** Decimal integer string (wei-scale). */
  simulatedOutput: string | null;
  quotedOutput: string | null;
  /** Signed percentage, e.g. -8.33 when the simulation came in 8.33% low. */
  outputDriftPercent: number | null;
  gasEstimate: string | null;
  balanceSufficient: boolean | null;
  nonceCurrent: boolean | null;
  nonceIssue: "STALE" | "GAP" | null;
  /** 0..1. */
  contentionScore: number | null;
  riskLevel: RiskLevel;
  flags: ForecastFlag[];
  timestamp: number;
  score: ScoreResult;
};

export type Policy = {
  action: PolicyAction;
  reason: string;
  suggestedAdjustment?: string;
};

export type EvaluateRequest = {
  tx: {
    from: string;
    to: string;
    data: string;
    /** Decimal integer string in wei — not a number, not hex. */
    value: string;
    nonce: number;
  };
  quotedOutput?: string;
};

export type EvaluateResponse = {
  forecast: Forecast;
  policy: Policy;
  explanation: string;
  /** Handle for reporting the outcome later. Null when the ledger write failed. */
  entryId: string | null;
};

export type UserAction = "SIGNED" | "CANCELLED" | "OVERRIDDEN";
export type TxOutcome = "CONFIRMED" | "FAILED" | "DROPPED" | "STUCK";

export type OutcomeRequest = {
  entryId: string;
  userAction: UserAction;
  outcome?: TxOutcome;
  txHash?: string;
};

export type OutcomeResponse = {
  ok: true;
  entryId: string;
  userAction: string;
  outcome: string | null;
  txHash: string | null;
};

export type SessionStats = {
  total: number;
  /** Keyed by PolicyAction. Missing keys mean zero, not absent data. */
  byAction: Record<string, number>;
  /** Keyed by TxOutcome. */
  byOutcome: Record<string, number>;
  overridden: number;
};

export type TxWatchStatus = "CONFIRMED" | "FAILED" | "NULL_PENDING" | "DROPPED" | "STUCK";

export type TxStatusReport = {
  status: TxWatchStatus;
  secondsPending: number;
  revertReason?: string;
  recommendation: string;
};

export type AlertType =
  "reserve_drift" | "contention_spike" | "failure_surge" | "approval_exposure" | "inactivity";

export type AlertSeverity = "info" | "warning" | "critical";

export type WatchType = "manual" | "auto";

// ── Wire shapes (snake_case, straight from SQLite) ─────────────────────

export type WireWatchlistItem = {
  contract_address: string;
  watch_type: WatchType;
  added_at: string;
  last_checked: string | null;
};

export type WireAlert = {
  id: string;
  contract_address: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  drift_pct: number | null;
  is_read: 0 | 1;
  dismissed: 0 | 1;
  created_at: string;
};

export type WireLedgerEntry = {
  id: string;
  tx_from: string;
  tx_to: string;
  tx_value: string | null;
  policy_action: PolicyAction;
  policy_reason: string;
  explanation: string | null;
  user_action: UserAction | null;
  outcome: TxOutcome | null;
  tx_hash: string | null;
  risk_level: RiskLevel | null;
  created_at: string;
};

// ── Normalized shapes (what components consume) ────────────────────────

export type WatchlistItem = {
  address: string;
  watchType: WatchType;
  addedAt: string;
  lastChecked: string | null;
};

export type Alert = {
  id: string;
  address: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  driftPct: number | null;
  isRead: boolean;
  dismissed: boolean;
  createdAt: string;
};

export type LedgerEntry = {
  id: string;
  from: string;
  to: string;
  value: string | null;
  action: PolicyAction;
  reason: string;
  explanation: string | null;
  userAction: UserAction | null;
  outcome: TxOutcome | null;
  txHash: string | null;
  riskLevel: RiskLevel | null;
  createdAt: string;
};

export type AlertSummary = {
  /** Includes dismissed alerts. */
  total: number;
  /** Excludes dismissed. */
  unread: number;
  /** Excludes dismissed. */
  critical: number;
  /** Includes dismissed — deliberately inconsistent with the two above. */
  bySeverity: Record<string, number>;
};

export type AlertQuery = {
  unread?: boolean;
  severity?: AlertSeverity;
  address?: string;
  limit?: number;
};
