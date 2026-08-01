import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Check, ExternalLink, Trash2, X } from "lucide-react";
import { AppShell } from "../components/app-shell";
import {
  useAddToWatchlist,
  useAlertSummary,
  useAlerts,
  useRemoveFromWatchlist,
  useUpdateAlert,
  useWatchlist,
} from "../hooks/api";
import type { AlertSeverity } from "../lib/api";
import { severityTone, toneClasses } from "../lib/risk";
import { relativeTime, shortAddress } from "../lib/format";
import { EXPLORER_ADDRESS_URL } from "../config/contracts";

export const Route = createFileRoute("/monitor")({
  component: Monitor,
});

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const ALERT_TYPE_LABEL: Record<string, string> = {
  reserve_drift: "Reserve drift",
  contention_spike: "Contention spike",
  failure_surge: "Failure surge",
  approval_exposure: "Approval exposure",
  inactivity: "Inactivity",
};

function Monitor() {
  const [newAddress, setNewAddress] = useState("");
  const [severity, setSeverity] = useState<AlertSeverity | "all">("all");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const watchlist = useWatchlist();
  const summary = useAlertSummary();
  const alerts = useAlerts({
    severity: severity === "all" ? undefined : severity,
    unread: unreadOnly || undefined,
  });
  const addWatch = useAddToWatchlist();
  const removeWatch = useRemoveFromWatchlist();
  const updateAlert = useUpdateAlert();

  const handleAdd = () => {
    const address = newAddress.trim();
    if (!ADDRESS_RE.test(address)) {
      toast.error("Enter a valid 0x address.");
      return;
    }
    addWatch.mutate(
      { address },
      {
        onSuccess: () => {
          setNewAddress("");
          toast.success("Now watching this contract.");
        },
        onError: (err) => {
          // Already-watching is a normal outcome of a user re-adding an address
          // the guard auto-watched, not a failure worth an error toast.
          if (err.kind === "AlreadyWatching") {
            setNewAddress("");
            toast("Already on the watchlist.");
            return;
          }
          toast.error(err.message);
        },
      },
    );
  };

  return (
    <AppShell>
      <header className="mb-8">
        <p className="tabular text-[10px] uppercase tracking-[0.3em] text-text-secondary">
          Autonomous monitor
        </p>
        <h1 className="mt-3 font-serif text-4xl tracking-tight">Monitor</h1>
        <p className="mt-2 max-w-xl text-sm text-text-secondary">
          The watchdog polls every watched contract on its own, every 15 seconds, and raises alerts
          without anyone asking it to. Open critical alerts also bias the guard's verdicts.
        </p>
      </header>

      {/* Summary tiles */}
      <div className="mb-8 grid gap-3 sm:grid-cols-4">
        {[
          { label: "Watching", value: watchlist.data?.length ?? 0, tone: "neutral" as const },
          { label: "Alerts", value: summary.data?.total ?? 0, tone: "neutral" as const },
          { label: "Unread", value: summary.data?.unread ?? 0, tone: "caution" as const },
          { label: "Critical", value: summary.data?.critical ?? 0, tone: "danger" as const },
        ].map((tile) => (
          <div key={tile.label} className="vantage-glass rounded-xl p-4">
            <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
              {tile.label}
            </p>
            <p
              className={`tabular mt-2 text-2xl ${tile.value > 0 ? toneClasses[tile.tone].text : "text-white/90"}`}
            >
              {tile.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        {/* Watchlist */}
        <section className="vantage-glass h-fit rounded-2xl p-6">
          <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
            Watchlist
          </p>

          <div className="mt-4 flex gap-2">
            <input
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder="0x…"
              className="tabular min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs outline-none focus:border-white/25"
            />
            <button
              onClick={handleAdd}
              disabled={addWatch.isPending}
              className="ease-precision rounded-lg bg-white px-4 text-[10px] uppercase tracking-[0.2em] text-black transition-all hover:bg-white/90 disabled:opacity-40"
            >
              Add
            </button>
          </div>

          <ul className="mt-5 space-y-2">
            {watchlist.data?.map((item) => (
              <li
                key={item.address}
                className="group flex items-center gap-2 rounded-lg border border-white/[0.06] px-3 py-2"
              >
                <a
                  href={EXPLORER_ADDRESS_URL(item.address)}
                  target="_blank"
                  rel="noreferrer"
                  className="tabular inline-flex items-center gap-1.5 text-xs text-white/90 transition-colors hover:text-white"
                >
                  {shortAddress(item.address)}
                  <ExternalLink className="h-3 w-3 opacity-40" />
                </a>
                <span
                  className={`tabular rounded-full px-2 py-0.5 text-[9px] uppercase tracking-[0.15em] ${
                    item.watchType === "auto"
                      ? "bg-white/[0.06] text-text-secondary"
                      : "bg-white/10 text-white/80"
                  }`}
                >
                  {item.watchType}
                </span>
                <button
                  onClick={() => removeWatch.mutate(item.address)}
                  className="ml-auto text-text-secondary opacity-0 transition-opacity hover:text-[color:var(--danger)] group-hover:opacity-100"
                  aria-label={`Stop watching ${item.address}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>

          {watchlist.data?.length === 0 && (
            <p className="mt-5 text-xs text-text-secondary">
              Nothing watched yet. Evaluating a transaction watches its target automatically.
            </p>
          )}
        </section>

        {/* Alert feed */}
        <section>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {(["all", "info", "warning", "critical"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSeverity(s)}
                className={`tabular ease-precision rounded-full border px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] transition-all ${
                  severity === s
                    ? "border-white/25 bg-white/[0.06] text-white"
                    : "border-white/[0.06] text-text-secondary hover:text-white/80"
                }`}
              >
                {s}
              </button>
            ))}
            <button
              onClick={() => setUnreadOnly((v) => !v)}
              className={`tabular ease-precision ml-auto rounded-full border px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] transition-all ${
                unreadOnly
                  ? "border-white/25 bg-white/[0.06] text-white"
                  : "border-white/[0.06] text-text-secondary hover:text-white/80"
              }`}
            >
              Unread only
            </button>
          </div>

          <ul className="space-y-2">
            {alerts.data?.map((alert) => {
              const t = toneClasses[severityTone(alert.severity)];
              return (
                <li
                  key={alert.id}
                  className={`ease-precision rounded-xl border p-4 ${t.border} ${alert.isRead ? "bg-transparent" : t.bg}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {!alert.isRead && <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />}
                    <span className={`tabular text-[10px] uppercase tracking-[0.2em] ${t.text}`}>
                      {ALERT_TYPE_LABEL[alert.type] ?? alert.type}
                    </span>
                    <span className="tabular text-[10px] uppercase tracking-[0.18em] text-text-secondary">
                      {shortAddress(alert.address)}
                    </span>
                    <span className="tabular ml-auto text-[10px] uppercase tracking-[0.18em] text-text-secondary">
                      {relativeTime(alert.createdAt)}
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-white/90">{alert.message}</p>

                  {alert.driftPct !== null && (
                    <p className={`tabular mt-1 text-xs ${t.text}`}>
                      Drift {alert.driftPct > 0 ? "+" : ""}
                      {alert.driftPct.toFixed(2)}%
                    </p>
                  )}

                  <div className="mt-3 flex gap-2">
                    {!alert.isRead && (
                      <button
                        onClick={() => updateAlert.mutate({ id: alert.id, read: true })}
                        className="tabular inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-text-secondary transition-colors hover:text-white/90"
                      >
                        <Check className="h-3 w-3" /> Mark read
                      </button>
                    )}
                    <button
                      onClick={() => updateAlert.mutate({ id: alert.id, dismissed: true })}
                      className="tabular inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-text-secondary transition-colors hover:text-white/90"
                    >
                      <X className="h-3 w-3" /> Dismiss
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {alerts.data?.length === 0 && (
            <div className="rounded-2xl border border-dashed border-white/[0.08] p-12 text-center">
              <p className="text-sm text-text-secondary">
                No alerts matching this filter. The watchdog polls every 15 seconds.
              </p>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
