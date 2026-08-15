// Single source of truth for how risk is presented.
//
// Every surface in the app maps a policy action, risk level or alert severity
// onto exactly one of three colours, so a user learns the vocabulary once:
//   safe (emerald)   — proceed
//   caution (amber)  — slow down, look closer
//   danger (crimson) — do not sign
import type {
  AlertSeverity,
  ConflictEvidence,
  ConflictFlag,
  ForecastFlag,
  PolicyAction,
  RiskLevel,
  TxWatchStatus,
} from "./api";

export type Tone = "safe" | "caution" | "danger" | "neutral";

/**
 * Direction read straight off a signed drift value. The backend computes
 * drift as (simulated − quoted) / quoted and the frontend only interprets the
 * sign: negative is worse than the quote, positive is better, zero matches.
 * The value is always the backend's number — never recomputed here.
 */
export type DriftDirection = "negative" | "positive" | "zero" | "unknown";

export function driftDirection(value: number | null | undefined): DriftDirection {
  if (value === null || value === undefined || !Number.isFinite(value)) return "unknown";
  if (value < 0) return "negative";
  if (value > 0) return "positive";
  return "zero";
}

/**
 * Drift-specific presentation, kept separate from toneClasses' safe/caution/
 * danger triad because drift has its own two-direction palette: red = output
 * worse than quoted, blue = output better than quoted, zero reads neutral.
 * The same map is used by the drift card and the compact Drift field, so the
 * two can never disagree about a direction.
 */
export const driftToneClasses: Record<
  DriftDirection,
  { text: string; border: string; bg: string; caption: string }
> = {
  negative: {
    text: "text-[color:var(--drift-negative)]",
    border: "border-[color:var(--drift-negative)]/30",
    bg: "bg-[color:var(--drift-negative)]/10",
    caption: "Worse than quoted",
  },
  positive: {
    text: "text-[color:var(--drift-positive)]",
    border: "border-[color:var(--drift-positive)]/30",
    bg: "bg-[color:var(--drift-positive)]/10",
    caption: "Better than quoted",
  },
  zero: {
    text: "text-text-secondary",
    border: "border-white/10",
    bg: "bg-white/[0.03]",
    caption: "Matches the quote",
  },
  // Defensive completeness: the drift card renders only for non-null drift and
  // the compact field maps null to an unstyled dash, so this branch is never
  // reached in the UI — it exists so driftDirection() stays total for callers
  // that have not yet guarded against null.
  unknown: {
    text: "text-text-secondary",
    border: "border-white/10",
    bg: "bg-white/[0.03]",
    caption: "Drift unavailable",
  },
};

export const toneClasses: Record<Tone, { text: string; border: string; bg: string; dot: string }> =
  {
    safe: {
      text: "text-[color:var(--safe)]",
      border: "border-[color:var(--safe)]/30",
      bg: "bg-[color:var(--safe)]/10",
      dot: "bg-[color:var(--safe)]",
    },
    caution: {
      text: "text-[color:var(--caution)]",
      border: "border-[color:var(--caution)]/30",
      bg: "bg-[color:var(--caution)]/10",
      dot: "bg-[color:var(--caution)]",
    },
    danger: {
      text: "text-[color:var(--danger)]",
      border: "border-[color:var(--danger)]/30",
      bg: "bg-[color:var(--danger)]/10",
      dot: "bg-[color:var(--danger)]",
    },
    neutral: {
      text: "text-text-secondary",
      border: "border-white/10",
      bg: "bg-white/[0.03]",
      dot: "bg-white/40",
    },
  };

export function actionTone(action: PolicyAction): Tone {
  switch (action) {
    case "PROCEED":
      return "safe";
    case "WARN":
    case "HOLD_AND_RECHECK":
    case "SUGGEST_ADJUSTMENT":
      return "caution";
    case "ABORT":
      return "danger";
  }
}

export function riskTone(level: RiskLevel): Tone {
  switch (level) {
    case "LOW":
      return "safe";
    case "MEDIUM":
      return "caution";
    case "HIGH":
    case "CRITICAL":
      return "danger";
  }
}

export function severityTone(severity: AlertSeverity): Tone {
  switch (severity) {
    case "info":
      return "neutral";
    case "warning":
      return "caution";
    case "critical":
      return "danger";
  }
}

export function watchTone(status: TxWatchStatus): Tone {
  switch (status) {
    case "CONFIRMED":
      return "safe";
    case "NULL_PENDING":
      return "neutral";
    case "STUCK":
      return "caution";
    case "FAILED":
    case "DROPPED":
      return "danger";
  }
}

/** Score bands mirror the action tones so a 0-100 number reads the same way. */
export function scoreTone(score: number): Tone {
  if (score >= 80) return "safe";
  if (score >= 50) return "caution";
  return "danger";
}

/**
 * The ECA's three discrete display states. Derived from the backend's own
 * conflict flags — a pure label mapping, never a re-derivation of the
 * classifier from the score. HIGH subsumes POTENTIAL, mirroring the backend
 * ladder.
 */
export type ConflictLevel = "NONE" | "POTENTIAL" | "HIGH";

export function conflictLevel(flags: readonly ConflictFlag[] | undefined): ConflictLevel {
  if (flags?.includes("HIGH_STATE_CONFLICT")) return "HIGH";
  if (flags?.includes("POTENTIAL_STATE_CONFLICT")) return "POTENTIAL";
  return "NONE";
}

/**
 * Conflict is a classifier, not a load meter: NONE is safe, POTENTIAL is a
 * warning, HIGH is a stop — the same safe/caution/danger vocabulary as every
 * other risk surface in the app.
 */
export function conflictLevelTone(level: ConflictLevel): Tone {
  switch (level) {
    case "NONE":
      return "safe";
    case "POTENTIAL":
      return "caution";
    case "HIGH":
      return "danger";
  }
}

export const actionLabel: Record<PolicyAction, string> = {
  PROCEED: "Proceed",
  WARN: "Warning",
  HOLD_AND_RECHECK: "Holding",
  SUGGEST_ADJUSTMENT: "Adjust",
  ABORT: "Abort",
};

/** Plain-English gloss for each flag, shown on hover in the verdict panel. */
export const flagDescription: Record<ForecastFlag, string> = {
  REVERT: "The simulation reverted — this transaction would fail on-chain.",
  STALE_STATE: "The simulated output differs from what you were quoted.",
  LOW_BALANCE: "The sending account cannot cover value plus gas.",
  NONCE_STALE: "This nonce has already been used — the transaction would be rejected.",
  NONCE_GAP: "There is a gap before this nonce, so it cannot be mined yet.",
  HIGH_CONTENTION: "The target contract is unusually busy; state may shift before inclusion.",
  WATCHDOG_CRITICAL_ALERTS: "The monitor has open critical alerts against this contract.",
  POTENTIAL_STATE_CONFLICT:
    "Competing pending transactions may change the target's state before this one executes.",
  HIGH_STATE_CONFLICT:
    "Competing pending transactions are racing this one for the same state — expect changes before execution.",
};

export const watchStatusLabel: Record<TxWatchStatus, string> = {
  CONFIRMED: "Confirmed",
  FAILED: "Failed",
  NULL_PENDING: "Propagating",
  STUCK: "Stuck",
  DROPPED: "Dropped",
};

/**
 * Human-readable explanation for the Execution Conflict card, built purely
 * from the backend's evidence snapshot. Never a client-side re-derivation:
 * the level comes from the backend's flags and every number from the
 * backend's counts.
 */
export function explainConflict(
  flags: readonly ConflictFlag[] | undefined,
  evidence: ConflictEvidence,
): string {
  const level = conflictLevel(flags);
  const plural = (n: number) => (n === 1 ? "" : "s");
  const wasWere = (n: number) => (n === 1 ? "was" : "were");
  // A logs-fallback estimate is weaker evidence than a real mempool view, and
  // the explanation says so rather than hiding it.
  const sourceNote =
    evidence.source === "logs-fallback"
      ? " The mempool could not be enumerated, so this is an estimate from log density on the target contract."
      : "";

  if (level !== "NONE") {
    const { competingSwapCount, competingPoolWriterCount, competingClaimCount, competingTxCount } =
      evidence;
    if (competingSwapCount > 0) {
      return `${competingSwapCount} competing swap${plural(competingSwapCount)} ${wasWere(competingSwapCount)} detected against the same liquidity pool.${sourceNote}`;
    }
    if (competingClaimCount > 0) {
      return `${competingClaimCount} competing claim${plural(competingClaimCount)} ${competingClaimCount === 1 ? "targets" : "target"} the same slot.${sourceNote}`;
    }
    if (competingPoolWriterCount > 0) {
      return `${competingPoolWriterCount} reserve-mutating transaction${plural(competingPoolWriterCount)} ${wasWere(competingPoolWriterCount)} detected against the same pool.${sourceNote}`;
    }
    if (competingTxCount > 0) {
      return `${competingTxCount} competing transaction${plural(competingTxCount)} ${wasWere(competingTxCount)} detected against the same contract.${sourceNote}`;
    }
    return level === "HIGH"
      ? `A high probability of state changes before execution was detected.${sourceNote}`
      : `Possible state changes before execution were detected.${sourceNote}`;
  }
  return "No competing transactions were detected in the mempool.";
}
