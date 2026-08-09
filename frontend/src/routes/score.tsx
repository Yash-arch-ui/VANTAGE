import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useAccount } from "wagmi";
import { AppShell } from "../components/app-shell";
import { ScoreBackground } from "../components/backgrounds/ScoreBackground";
import { useScore } from "../hooks/api";
import { scoreTone, toneClasses } from "../lib/risk";
import { shortAddress } from "../lib/format";
import { AMM_ADDRESS, MOCK_CLAIM_ADDRESS } from "../config/contracts";

export const Route = createFileRoute("/score")({
  component: ScorePage,
});

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * The score is 100 minus four penalties. Showing each penalty against its
 * maximum is the difference between "62" and "62, and here is exactly why".
 * Weights mirror services/scoring.ts on the backend.
 */
const PENALTIES = [
  {
    key: "failureRate" as const,
    label: "Failure rate",
    max: 40,
    compute: (b: { failureRate: number }) => 40 * b.failureRate,
    describe: (b: { failureRate: number }) =>
      `${(b.failureRate * 100).toFixed(1)}% of recent evaluations ended in a failed transaction`,
  },
  {
    key: "alertCount" as const,
    label: "Open alerts",
    max: 30,
    compute: (b: { alertCount: number }) => Math.min(30, b.alertCount),
    describe: (b: { alertCount: number }) =>
      `weighted alert load of ${b.alertCount} (critical counts 15, warning 5, info 1)`,
  },
  {
    key: "contentionStability" as const,
    label: "Contention",
    max: 15,
    compute: (b: { contentionStability: number }) => 15 * b.contentionStability,
    describe: (b: { contentionStability: number }) =>
      `contention running at ${(b.contentionStability * 100).toFixed(0)}%`,
  },
  {
    key: "sampleSize" as const,
    label: "Thin history",
    max: 15,
    compute: (b: { sampleSize: number }) => (b.sampleSize < 5 ? 15 : 0),
    describe: (b: { sampleSize: number }) =>
      b.sampleSize < 5
        ? `only ${b.sampleSize} evaluation${b.sampleSize === 1 ? "" : "s"} on record — too little to trust`
        : `${b.sampleSize} evaluations on record`,
  },
];

function ScorePage() {
  const { address: connected } = useAccount();
  const [address, setAddress] = useState<string>(AMM_ADDRESS);
  const valid = ADDRESS_RE.test(address);
  const { data, isLoading } = useScore(valid ? address : undefined);

  const quickLinks = [
    { label: "AMM", value: AMM_ADDRESS },
    { label: "MockClaim", value: MOCK_CLAIM_ADDRESS },
    ...(connected ? [{ label: "My wallet", value: connected }] : []),
  ];

  return (
    <AppShell>
      {/* Ambient backdrop. Fixed, inset-0, z-0, pointer-events none — strictly
          behind the positioned content below; never intercepts a click. */}
      <ScoreBackground />
      {/* relative z-10 lifts the page content into a positioned layer so it
          paints unambiguously above the z-0 background (static content would
          otherwise paint beneath a fixed z-0 element). */}
      <div className="relative z-10">
        <header className="mb-8">
          <p className="tabular text-[10px] uppercase tracking-[0.3em] text-text-secondary">
            Contract trust
          </p>
          <h1 className="mt-3 font-serif text-4xl tracking-tight">Vantage Score</h1>
          <p className="mt-2 max-w-xl text-sm text-text-secondary">
            A 0-100 score aggregated purely from recorded outcomes — failures, open alerts,
            contention and how much history there is to go on. No model, no opinion.
          </p>
        </header>

        <div className="mb-6 flex flex-wrap gap-2">
          {quickLinks.map((link) => (
            <button
              key={link.value}
              onClick={() => setAddress(link.value)}
              className={`tabular ease-precision rounded-full border px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] transition-all ${
                address.toLowerCase() === link.value.toLowerCase()
                  ? "border-white/25 bg-white/[0.06] text-white"
                  : "border-white/[0.06] text-text-secondary hover:text-white/80"
              }`}
            >
              {link.label}
            </button>
          ))}
        </div>

        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="0x…"
          className="tabular mb-8 w-full max-w-xl rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm outline-none focus:border-white/25"
        />

        {!valid && (
          <p className="text-sm text-[color:var(--caution)]">Enter a valid 0x contract address.</p>
        )}

        {valid && isLoading && <p className="text-sm text-text-secondary">Loading…</p>}

        {/* scored:false is a legitimate answer, not an error — a contract nobody
          has evaluated has no evidence to score, and pretending it scores 100
          would be exactly backwards. */}
        {valid && data && !data.scored && (
          <div className="vantage-glass rounded-2xl p-8">
            <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
              Not yet scored
            </p>
            <p className="mt-3 max-w-md text-sm text-white/90">
              {shortAddress(address)} has never been evaluated, so there is nothing to score it on.
              Run a transaction against it in the Guard console and a score appears here.
            </p>
          </div>
        )}

        {valid && data?.scored && (
          <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
            <div className="vantage-glass flex flex-col items-center justify-center rounded-2xl p-8">
              <p className={`tabular text-7xl ${toneClasses[scoreTone(data.score)].text}`}>
                {data.score}
              </p>
              <p className="tabular mt-2 text-[10px] uppercase tracking-[0.2em] text-text-secondary">
                out of 100
              </p>
              <div className="mt-6 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className={`h-full ${toneClasses[scoreTone(data.score)].dot}`}
                  style={{ width: `${data.score}%` }}
                />
              </div>
            </div>

            <div className="vantage-glass rounded-2xl p-6">
              <p className="tabular text-[10px] uppercase tracking-[0.2em] text-text-secondary">
                Where the points went
              </p>

              <div className="mt-5 space-y-5">
                {PENALTIES.map((p) => {
                  const lost = p.compute(data.breakdown);
                  return (
                    <div key={p.key}>
                      <div className="flex items-baseline justify-between">
                        <span className="text-sm text-white/90">{p.label}</span>
                        <span
                          className={`tabular text-sm ${lost > 0 ? toneClasses.danger.text : "text-text-secondary"}`}
                        >
                          {lost > 0 ? `−${lost.toFixed(1)}` : "0"}
                          <span className="text-text-secondary"> / {p.max}</span>
                        </span>
                      </div>
                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
                        <div
                          className="h-full bg-[color:var(--danger)]/60"
                          style={{ width: `${Math.min(100, (lost / p.max) * 100)}%` }}
                        />
                      </div>
                      <p className="mt-1.5 text-xs text-text-secondary">
                        {p.describe(data.breakdown)}
                      </p>
                    </div>
                  );
                })}
              </div>

              <p className="tabular mt-6 border-t border-white/[0.06] pt-4 text-[10px] uppercase tracking-[0.18em] text-text-secondary">
                Updated {new Date(data.lastUpdated).toLocaleString()}
              </p>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
