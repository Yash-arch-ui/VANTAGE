import { useEffect, useState } from "react";

/**
 * /api/evaluate can legitimately take ~30 seconds: when the policy resolves to
 * HOLD_AND_RECHECK the backend re-polls chain state until contention clears.
 * A plain spinner reads as "hung" at that length, so this narrates what the
 * backend is actually doing and shows elapsed time.
 */
const STAGES = [
  { at: 0, label: "Simulating against live chain state" },
  { at: 3, label: "Checking nonce, balance and contention" },
  { at: 6, label: "Contention is high — holding and re-checking" },
  { at: 20, label: "Still holding. This resolves or suggests an adjustment at 30s" },
];

export function Evaluating() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const stage = [...STAGES].reverse().find((s) => elapsed >= s.at) ?? STAGES[0];

  return (
    <section className="vantage-glass rounded-2xl p-6">
      <div className="flex items-center gap-3">
        <span className="pulse-live h-1.5 w-1.5 rounded-full bg-[color:var(--caution)]" />
        <p className="tabular text-[10px] uppercase tracking-[0.25em] text-text-secondary">
          Evaluating · {elapsed}s
        </p>
      </div>
      <p className="mt-3 text-sm text-white/90">{stage.label}</p>
      <div className="mt-4 h-px w-full overflow-hidden bg-white/[0.06]">
        <div
          className="h-full bg-[color:var(--caution)]/60 transition-all duration-1000"
          // 30s is the backend's hold timeout, so the bar tracks a real deadline.
          style={{ width: `${Math.min(100, (elapsed / 30) * 100)}%` }}
        />
      </div>
    </section>
  );
}
