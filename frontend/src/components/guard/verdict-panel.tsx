import { motion } from "motion/react";
import { Sparkles } from "lucide-react";
import type { EvaluateResponse } from "../../lib/api";
import {
  actionLabel,
  actionTone,
  flagDescription,
  riskTone,
  scoreTone,
  toneClasses,
} from "../../lib/risk";
import { formatGas, formatPercent, formatToken } from "../../lib/format";
import { apexSpring } from "../../lib/motion";

function Field({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: keyof typeof toneClasses;
}) {
  return (
    <div className="border-t border-white/[0.06] py-3">
      <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">{label}</p>
      <p className={`tabular mt-1 text-sm ${toneClasses[tone].text}`}>{value}</p>
    </div>
  );
}

export function VerdictPanel({ result }: { result: EvaluateResponse }) {
  const { forecast, policy, explanation } = result;
  const tone = actionTone(policy.action);
  const t = toneClasses[tone];

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={apexSpring}
      className="vantage-glass ease-precision rounded-2xl p-6"
    >
      {/* Verdict */}
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`tabular inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[11px] uppercase tracking-[0.25em] ${t.border} ${t.bg} ${t.text}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
          {actionLabel[policy.action]}
        </span>
        <span
          className={`tabular text-[10px] uppercase tracking-[0.2em] ${toneClasses[riskTone(forecast.riskLevel)].text}`}
        >
          Risk {forecast.riskLevel}
        </span>
      </div>

      <p className="mt-4 text-sm text-white/90">{policy.reason}</p>

      {policy.suggestedAdjustment && (
        <p className="mt-2 text-sm text-[color:var(--caution)]">{policy.suggestedAdjustment}</p>
      )}

      {/* State drift — only when the backend flagged the quote as stale. The
          three values come straight from the evaluate response, never recomputed. */}
      {forecast.flags.includes("STALE_STATE") && (
        <div className="mt-4 rounded-xl border border-[color:var(--caution)]/30 bg-[color:var(--caution)]/10 p-4">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
            <div>
              <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">State Drift</p>
              <p className="tabular mt-1 text-xl font-medium text-[color:var(--caution)]">
                {formatPercent(forecast.outputDriftPercent)}
              </p>
            </div>
            <div>
              <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">Status</p>
              <p className="tabular mt-1 text-xl font-medium text-[color:var(--caution)]">STALE_STATE</p>
            </div>
            <div>
              <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">Decision</p>
              <p className="tabular mt-1 text-xl font-medium text-[color:var(--caution)]">{policy.action}</p>
            </div>
          </div>
        </div>
      )}

      {/* The one AI component in the system — labelled, because "6 of 7 are
          deterministic" is a claim worth making visible rather than asserting. */}
      <div className="mt-5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <p className="tabular flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-text-secondary">
          <Sparkles className="h-3 w-3" />
          In plain English
        </p>
        <p className="mt-2 text-sm leading-relaxed text-white/90">{explanation}</p>
      </div>

      {/* Flags */}
      {forecast.flags.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {forecast.flags.map((flag) => (
            <span
              key={flag}
              title={flagDescription[flag] ?? flag}
              className="tabular cursor-help rounded-full border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/10 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[color:var(--danger)]"
            >
              {flag.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}

      {/* Forecast detail */}
      <div className="mt-6 grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Quoted output" value={formatToken(forecast.quotedOutput)} />
        <Field
          label="Simulated output"
          value={formatToken(forecast.simulatedOutput)}
          tone={forecast.outputDriftPercent === null ? "neutral" : tone}
        />
        <Field
          label="Drift"
          value={formatPercent(forecast.outputDriftPercent)}
          tone={
            forecast.outputDriftPercent === null
              ? "neutral"
              : Math.abs(forecast.outputDriftPercent) > 1
                ? "caution"
                : "safe"
          }
        />
        <Field
          label="Simulation"
          value={forecast.simulationSuccess ? "Succeeded" : "Reverted"}
          tone={forecast.simulationSuccess ? "safe" : "danger"}
        />
        <Field label="Gas estimate" value={formatGas(forecast.gasEstimate)} />
        <Field
          label="Contention"
          value={
            forecast.contentionScore === null
              ? "—"
              : `${(forecast.contentionScore * 100).toFixed(0)}%`
          }
          tone={
            forecast.contentionScore === null
              ? "neutral"
              : forecast.contentionScore > 0.7
                ? "danger"
                : forecast.contentionScore > 0.4
                  ? "caution"
                  : "safe"
          }
        />
        <Field
          label="Balance"
          value={
            forecast.balanceSufficient === null
              ? "—"
              : forecast.balanceSufficient
                ? "Sufficient"
                : "Insufficient"
          }
          tone={forecast.balanceSufficient === false ? "danger" : "neutral"}
        />
        <Field
          label="Nonce"
          value={forecast.nonceIssue ?? (forecast.nonceCurrent ? "Current" : "—")}
          tone={forecast.nonceIssue ? "danger" : "neutral"}
        />
        {forecast.revertReason && (
          <Field label="Revert reason" value={forecast.revertReason} tone="danger" />
        )}
      </div>

      {/* Contract score */}
      {forecast.score.scored && (
        <div className="mt-6 flex items-center gap-4 border-t border-white/[0.06] pt-5">
          <div>
            <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
              Contract score
            </p>
            <p
              className={`tabular mt-1 text-3xl ${toneClasses[scoreTone(forecast.score.score)].text}`}
            >
              {forecast.score.score}
              <span className="text-sm text-text-secondary">/100</span>
            </p>
          </div>
          <p className="max-w-xs text-xs leading-relaxed text-text-secondary">
            Based on {forecast.score.breakdown.sampleSize} recorded evaluation
            {forecast.score.breakdown.sampleSize === 1 ? "" : "s"} of this contract.
          </p>
        </div>
      )}
    </motion.section>
  );
}
