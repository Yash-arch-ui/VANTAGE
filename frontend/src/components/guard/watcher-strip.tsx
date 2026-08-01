import { ExternalLink } from "lucide-react";
import { useTxStatus } from "../../hooks/api";
import { toneClasses, watchStatusLabel, watchTone } from "../../lib/risk";
import { EXPLORER_TX_URL } from "../../config/contracts";
import { shortAddress } from "../../lib/format";

/**
 * Live status of a broadcast transaction.
 *
 * This is the Monad-specific piece: a null receipt can mean "still
 * propagating", "stuck" or "dropped", and naive polling reports all three as
 * the same nothing. The backend disambiguates them; this shows which one.
 */
export function WatcherStrip({ txHash, submittedAt }: { txHash: string; submittedAt: number }) {
  const { data, isLoading } = useTxStatus(txHash, submittedAt);

  const tone = data ? watchTone(data.status) : "neutral";
  const t = toneClasses[tone];

  return (
    <section className={`ease-precision rounded-2xl border p-5 ${t.border} ${t.bg}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`h-1.5 w-1.5 rounded-full ${t.dot} ${
            data && (data.status === "NULL_PENDING" || data.status === "STUCK") ? "pulse-live" : ""
          }`}
        />
        <span className={`tabular text-[11px] uppercase tracking-[0.25em] ${t.text}`}>
          {isLoading || !data ? "Watching" : watchStatusLabel[data.status]}
        </span>
        {data && (
          <span className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
            {data.secondsPending}s pending
          </span>
        )}
        <a
          href={EXPLORER_TX_URL(txHash)}
          target="_blank"
          rel="noreferrer"
          className="tabular ml-auto inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-text-secondary transition-colors hover:text-white/90"
        >
          {shortAddress(txHash, 8, 6)}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {data && <p className="mt-3 text-sm text-white/80">{data.recommendation}</p>}
      {data?.revertReason && (
        <p className="tabular mt-2 text-xs text-[color:var(--danger)]">{data.revertReason}</p>
      )}
    </section>
  );
}
