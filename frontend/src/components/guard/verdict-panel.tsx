import { motion } from "motion/react";
import { Sparkles } from "lucide-react";
import type { EvaluateResponse } from "../../lib/api";
import { ExecutionConflictCard } from "./execution-conflict";
import {
  actionLabel,
  actionTone,
  driftDirection,
  driftToneClasses,
  flagDescription,
  riskTone,
  scoreTone,
  toneClasses,
} from "../../lib/risk";
import { formatDriftPercent, formatGas, formatToken } from "../../lib/format";
import { apexSpring } from "../../lib/motion";

function Field({
  label,
  value,
  tone = "neutral",
  textClass,
}: {
  label: string;
  value: string;
  tone?: keyof typeof toneClasses;
  /** Overrides the tone colour when direction carries the meaning (e.g. drift). */
  textClass?: string;
}) {
  return (
    <div className="border-t border-white/[0.06] py-3">
      <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">{label}</p>
      <p className={`tabular mt-1 text-sm ${textClass ?? toneClasses[tone].text}`}>{value}</p>
    </div>
  );
}

export function VerdictPanel({ result }: { result: EvaluateResponse }) {
  const { forecast, policy, explanation } = result;
  const tone = actionTone(policy.action);
  const t = toneClasses[tone];
  // Direction is read straight off the backend's signed drift number — never
  // recomputed. Both swap directions (token→MON and MON→token) reach this as
  // the same signed value, so no direction is hardcoded here.
  const drift = forecast.outputDriftPercent;
  const driftTone = driftToneClasses[driftDirection(drift)];
  const isStale = forecast.flags.includes("STALE_STATE");

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

      {/* State drift — shown for BOTH directions whenever the backend reports a
          drift (outputDriftPercent !== null), so a positive drift reads as
          clearly as a negative one. Direction and colour come straight from the
          backend's signed number; when a /api/recheck merges a new value into
          the result, this card simply re-renders with it. */}
      {drift !== null && (
        <div className={`mt-4 rounded-xl border p-4 ${driftTone.border} ${driftTone.bg}`}>
          <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
            <div className="min-w-44">
              <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
                State drift
              </p>
              <p className={`tabular mt-1 text-2xl font-semibold tracking-tight ${driftTone.text}`}>
                {formatDriftPercent(drift)}
              </p>
              <p
                className={`tabular mt-1 text-[10px] uppercase tracking-[0.18em] ${driftTone.text}`}
              >
                {driftTone.caption}
              </p>
            </div>
            <div>
              <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
                Status
              </p>
              <p className={`tabular mt-1 text-xl font-medium ${driftTone.text}`}>
                {isStale ? "STALE_STATE" : "Current"}
              </p>
            </div>
            <div>
              <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
                Decision
              </p>
              <p className={`tabular mt-1 text-xl font-medium ${t.text}`}>{policy.action}</p>
            </div>
          </div>
        </div>
      )}

      {/* Execution Conflict — a pure render of the backend ECA's forecast
          fields (conflictScore / conflictFlags / conflictEvidence). The card
          re-renders with the same merged result state, so a /api/recheck
          update flows in without any polling or API changes here. */}
      <ExecutionConflictCard forecast={forecast} />

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
          value={formatDriftPercent(drift)}
          textClass={drift === null ? undefined : driftTone.text}
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
