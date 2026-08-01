import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { AppShell } from "../components/app-shell";
import { useLedger, useStats } from "../hooks/api";
import { actionLabel, actionTone, riskTone, toneClasses } from "../lib/risk";
import { relativeTime, shortAddress } from "../lib/format";
import { EXPLORER_ADDRESS_URL, EXPLORER_TX_URL } from "../config/contracts";
import type { TxOutcome } from "../lib/api";

export const Route = createFileRoute("/ledger")({
  component: LedgerPage,
});

const PAGE_SIZE = 20;

const OUTCOME_TONE: Record<TxOutcome, "safe" | "caution" | "danger"> = {
  CONFIRMED: "safe",
  FAILED: "danger",
  DROPPED: "danger",
  STUCK: "caution",
};

function LedgerPage() {
  const [offset, setOffset] = useState(0);
  const stats = useStats();
  const { data, isLoading } = useLedger({ limit: PAGE_SIZE, offset });

  const total = data?.total ?? 0;
  const hasMore = offset + PAGE_SIZE < total;

  // If rows disappear beneath the current page (a refetch, a shrinking total),
  // walk back rather than stranding the user on a bare table header with the
  // Previous button hidden and no empty state shown.
  useEffect(() => {
    if (!isLoading && offset > 0 && offset >= total) {
      setOffset(Math.max(0, Math.floor(Math.max(0, total - 1) / PAGE_SIZE) * PAGE_SIZE));
    }
  }, [isLoading, offset, total]);

  return (
    <AppShell>
      <header className="mb-8">
        <p className="tabular text-[10px] uppercase tracking-[0.3em] text-text-secondary">
          Execution memory
        </p>
        <h1 className="mt-3 font-serif text-4xl tracking-tight">Ledger</h1>
        <p className="mt-2 max-w-xl text-sm text-text-secondary">
          Every decision Vantage has made, and what actually happened afterwards. This is the
          evidence behind the claims — not a summary of them.
        </p>
      </header>

      {/* Aggregates */}
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="vantage-glass rounded-xl p-4">
          <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
            Evaluated
          </p>
          <p className="tabular mt-2 text-2xl text-white/90">{stats.data?.total ?? 0}</p>
        </div>
        <div className="vantage-glass rounded-xl p-4">
          <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
            Blocked or flagged
          </p>
          <p className={`tabular mt-2 text-2xl ${toneClasses.caution.text}`}>
            {(stats.data?.byAction.ABORT ?? 0) +
              (stats.data?.byAction.WARN ?? 0) +
              (stats.data?.byAction.SUGGEST_ADJUSTMENT ?? 0)}
          </p>
        </div>
        <div className="vantage-glass rounded-xl p-4">
          <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
            Confirmed
          </p>
          <p className={`tabular mt-2 text-2xl ${toneClasses.safe.text}`}>
            {stats.data?.byOutcome.CONFIRMED ?? 0}
          </p>
        </div>
        <div className="vantage-glass rounded-xl p-4">
          <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
            Overridden
          </p>
          <p className={`tabular mt-2 text-2xl ${toneClasses.danger.text}`}>
            {stats.data?.overridden ?? 0}
          </p>
        </div>
      </div>

      {/* Timeline */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-left">
          <thead>
            <tr className="tabular border-b border-white/[0.06] text-[10px] uppercase tracking-[0.2em] text-text-secondary">
              <th className="py-3 pr-4 font-normal">Verdict</th>
              <th className="py-3 pr-4 font-normal">Risk</th>
              <th className="py-3 pr-4 font-normal">Contract</th>
              <th className="py-3 pr-4 font-normal">Reason</th>
              <th className="py-3 pr-4 font-normal">Outcome</th>
              <th className="py-3 pr-4 font-normal">When</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((entry) => {
              const t = toneClasses[actionTone(entry.action)];
              return (
                <tr key={entry.id} className="border-b border-white/[0.04] align-top">
                  <td className="py-4 pr-4">
                    <span
                      className={`tabular inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${t.border} ${t.bg} ${t.text}`}
                    >
                      <span className={`h-1 w-1 rounded-full ${t.dot}`} />
                      {actionLabel[entry.action]}
                    </span>
                  </td>
                  <td className="py-4 pr-4">
                    <span
                      className={`tabular text-[10px] uppercase tracking-[0.18em] ${
                        entry.riskLevel
                          ? toneClasses[riskTone(entry.riskLevel)].text
                          : "text-text-secondary"
                      }`}
                    >
                      {entry.riskLevel ?? "—"}
                    </span>
                  </td>
                  <td className="py-4 pr-4">
                    <a
                      href={EXPLORER_ADDRESS_URL(entry.to)}
                      target="_blank"
                      rel="noreferrer"
                      className="tabular inline-flex items-center gap-1.5 text-xs text-white/80 transition-colors hover:text-white"
                    >
                      {shortAddress(entry.to)}
                      <ExternalLink className="h-3 w-3 opacity-40" />
                    </a>
                  </td>
                  <td className="max-w-md py-4 pr-4">
                    <p className="text-xs leading-relaxed text-white/80">{entry.reason}</p>
                    {entry.explanation && (
                      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                        {entry.explanation}
                      </p>
                    )}
                  </td>
                  <td className="py-4 pr-4">
                    {entry.outcome ? (
                      <span
                        className={`tabular text-[10px] uppercase tracking-[0.18em] ${toneClasses[OUTCOME_TONE[entry.outcome]].text}`}
                      >
                        {entry.outcome}
                      </span>
                    ) : (
                      <span className="tabular text-[10px] uppercase tracking-[0.18em] text-text-secondary">
                        {entry.userAction ?? "—"}
                      </span>
                    )}
                    {entry.txHash && (
                      <a
                        href={EXPLORER_TX_URL(entry.txHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="tabular mt-1 block text-[10px] text-text-secondary transition-colors hover:text-white/80"
                      >
                        {shortAddress(entry.txHash, 6, 4)}
                      </a>
                    )}
                  </td>
                  <td className="tabular py-4 pr-4 text-[10px] uppercase tracking-[0.18em] text-text-secondary">
                    {relativeTime(entry.createdAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!isLoading && total === 0 && (
        <div className="rounded-2xl border border-dashed border-white/[0.08] p-12 text-center">
          <p className="text-sm text-text-secondary">
            Nothing recorded yet. Evaluate a transaction in the Guard console.
          </p>
        </div>
      )}

      {(offset > 0 || hasMore) && (
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            disabled={offset === 0}
            className="tabular rounded-full border border-white/10 px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-text-secondary transition-colors hover:text-white/90 disabled:opacity-30"
          >
            Previous
          </button>
          <span className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            disabled={!hasMore}
            className="tabular rounded-full border border-white/10 px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-text-secondary transition-colors hover:text-white/90 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </AppShell>
  );
}
