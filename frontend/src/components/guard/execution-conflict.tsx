import { Radar } from "lucide-react";
import type { ConflictEvidence, Forecast } from "../../lib/api";
import {
  conflictLevel,
  conflictLevelTone,
  explainConflict,
  toneClasses,
  type ConflictLevel,
} from "../../lib/risk";

/**
 * The ECA's three discrete classifier states — a segmented readout, never a
 * meter. The backend derives them from conflictScore with a strict ladder; the
 * card only maps the backend's flags to labels.
 */
const LEVELS: ConflictLevel[] = ["NONE", "POTENTIAL", "HIGH"];

/** Display labels for the backend's evidence source — a verbatim mapping. */
const SOURCE_LABEL: Record<ConflictEvidence["source"], string> = {
  "pending-block": "MEMPOOL VIEW",
  "logs-fallback": "LOG-DENSITY ESTIMATE",
};

/**
 * Execution Conflict card — a pure render of the backend ECA's forecast
 * fields. It sits between the State drift card and "In plain English" in the
 * verdict panel and reacts to the same merged result state, so a background
 * recheck that updates conflictScore or the conflict flags simply re-renders
 * it. No backend call originates here.
 */
export function ExecutionConflictCard({ forecast }: { forecast: Forecast }) {
  const { conflictScore, conflictFlags, conflictEvidence: evidence } = forecast;
  // No evidence snapshot (a backend predating the ECA, or a scan that never
  // ran) — the card has nothing to say and stays out of the way.
  if (!evidence) return null;

  const level = conflictLevel(conflictFlags);
  const t = toneClasses[conflictLevelTone(level)];
  const scoreText =
    conflictScore === null || conflictScore === undefined ? "—" : conflictScore.toFixed(3);

  // Evidence chips — each hidden when the backend counted zero (or the count
  // is absent). Only backend counts are shown, never computed values.
  const chips = [
    { label: "Competing transactions", count: evidence.competingTxCount },
    { label: "Competing swaps", count: evidence.competingSwapCount },
    { label: "Pool writers", count: evidence.competingPoolWriterCount },
    { label: "Same-slot claims", count: evidence.competingClaimCount },
  ].filter((chip) => chip.count > 0);

  return (
    <div className={`mt-4 rounded-xl border p-4 ${t.border} ${t.bg}`}>
      <div className="flex flex-wrap items-center gap-3">
        <p className="tabular flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-text-secondary">
          <Radar className="h-3 w-3" />
          Execution conflict
        </p>
        {/* Source comes straight from the backend's evidence — never inferred. */}
        <span className={`tabular ml-auto text-[10px] uppercase tracking-[0.18em] ${t.text}`}>
          {SOURCE_LABEL[evidence.source]}
        </span>
      </div>

      {/* Three discrete classifier states; the active one is emphasised. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {LEVELS.map((candidate) => {
          const active = candidate === level;
          const candidateTone = toneClasses[conflictLevelTone(candidate)];
          return (
            <span
              key={candidate}
              className={`tabular rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.18em] transition-colors ${
                active
                  ? `${candidateTone.border} ${candidateTone.bg} ${candidateTone.text}`
                  : "border-white/[0.06] text-text-secondary"
              }`}
            >
              {candidate}
            </span>
          );
        })}
      </div>

      {/* The score is a classifier, not a load meter — a plain number. */}
      <div className="mt-3">
        <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
          Conflict score
        </p>
        <p className={`tabular mt-1 text-2xl font-semibold tracking-tight ${t.text}`}>
          {scoreText}
        </p>
      </div>

      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <span
              key={chip.label}
              className="tabular rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-white/80"
            >
              {chip.label} · {chip.count}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
        <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
          Explanation
        </p>
        <p className="mt-1 text-xs leading-relaxed text-white/90">
          {explainConflict(conflictFlags, evidence)}
        </p>
      </div>
    </div>
  );
}
