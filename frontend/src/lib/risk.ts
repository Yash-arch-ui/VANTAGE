// Single source of truth for how risk is presented.
//
// Every surface in the app maps a policy action, risk level or alert severity
// onto exactly one of three colours, so a user learns the vocabulary once:
//   safe (emerald)   — proceed
//   caution (amber)  — slow down, look closer
//   danger (crimson) — do not sign
import type { AlertSeverity, ForecastFlag, PolicyAction, RiskLevel, TxWatchStatus } from "./api";

export type Tone = "safe" | "caution" | "danger" | "neutral";

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
};

export const watchStatusLabel: Record<TxWatchStatus, string> = {
  CONFIRMED: "Confirmed",
  FAILED: "Failed",
  NULL_PENDING: "Propagating",
  STUCK: "Stuck",
  DROPPED: "Dropped",
};
