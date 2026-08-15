import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VerdictPanel } from "./verdict-panel";
import type { ConflictEvidence, EvaluateResponse, Forecast, ForecastFlag } from "../../lib/api";

// Direction classes the drift display is expected to carry. Asserted on the
// rendered elements' className, exactly as they come from driftToneClasses.
const NEGATIVE = "text-[color:var(--drift-negative)]";
const POSITIVE = "text-[color:var(--drift-positive)]";
const NEUTRAL = "text-text-secondary";

/**
 * Build a minimal-but-typed EvaluateResponse. The panel is a pure function of
 * this prop — a background /api/recheck response merged in app.tsx produces a
 * new EvaluateResponse with a different outputDriftPercent, which is exactly
 * what the transition tests below simulate with rerender.
 */
function makeForecast(drift: number | null, flags: ForecastFlag[] = []): Forecast {
  return {
    simulationSuccess: true,
    revertReason: null,
    simulatedOutput: "105000000000000000000",
    quotedOutput: "100000000000000000000",
    outputDriftPercent: drift,
    gasEstimate: "21000",
    balanceSufficient: true,
    nonceCurrent: true,
    nonceIssue: null,
    contentionScore: 0.1,
    riskLevel: "LOW",
    flags,
    timestamp: 1_700_000_000_000,
    score: {
      scored: false,
      score: null,
      breakdown: { failureRate: 0, alertCount: 0, contentionStability: 1, sampleSize: 0 },
      lastUpdated: "2026-01-01T00:00:00.000Z",
    },
  };
}

function makeResult(drift: number | null, flags: ForecastFlag[] = []): EvaluateResponse {
  return {
    forecast: makeForecast(drift, flags),
    policy: { action: "PROCEED", reason: "All signals clear; no flags raised." },
    explanation: "All risk signals are clear. The transaction is ready to submit.",
    entryId: "entry-1",
  };
}

/** A forecast carrying the backend ECA's evidence, for the conflict card. */
function makeConflictForecast(): Forecast {
  const evidence: ConflictEvidence = {
    source: "pending-block",
    scannedAt: 1_700_000_000_000,
    competingTxCount: 2,
    competingSwapCount: 2,
    competingPoolWriterCount: 0,
    competingClaimCount: 0,
    pendingPoolSize: 14,
    excludedSameSenderCount: 1,
    excludedNonViableCount: 0,
    relevantTxs: [],
  };
  return {
    ...makeForecast(-8.12, ["HIGH_STATE_CONFLICT"]),
    conflictScore: 0.614,
    conflictFlags: ["HIGH_STATE_CONFLICT"],
    conflictEvidence: evidence,
    // Scored so the Contract score section renders too — the placement test
    // asserts every pre-existing card is still present.
    score: {
      scored: true,
      score: 88,
      breakdown: { failureRate: 0, alertCount: 0, contentionStability: 1, sampleSize: 12 },
      lastUpdated: "2026-01-01T00:00:00.000Z",
    },
  };
}

/**
 * The drift value renders in two places — the headline drift card and the
 * compact Drift field — and both must carry the same direction colour, so
 * every match is asserted rather than just the first.
 */
function expectEveryDrift(driftText: string, colourClass: string) {
  const matches = screen.getAllByText(driftText);
  expect(matches.length).toBeGreaterThan(0);
  for (const el of matches) {
    expect(el.className).toContain(colourClass);
  }
}

describe("VerdictPanel — drift card direction", () => {
  it("renders negative drift in red as worse than quoted", () => {
    render(<VerdictPanel result={makeResult(-10.68, ["STALE_STATE"])} />);

    expectEveryDrift("-10.68%", NEGATIVE);
    // The caption spells the direction out in the card's own words.
    expect(screen.getByText("Worse than quoted")).toBeInTheDocument();
    // The STALE_STATE status stays visible exactly as before.
    expect(screen.getByText("STALE_STATE")).toBeInTheDocument();
  });

  it("renders positive drift in blue as better than quoted", () => {
    render(<VerdictPanel result={makeResult(8.42)} />);

    expectEveryDrift("+8.42%", POSITIVE);
    expect(screen.getByText("Better than quoted")).toBeInTheDocument();
  });

  it("renders zero drift neutral — neither red nor blue", () => {
    render(<VerdictPanel result={makeResult(0)} />);

    const matches = screen.getAllByText("0.00%");
    for (const el of matches) {
      expect(el.className).toContain(NEUTRAL);
      expect(el.className).not.toContain(NEGATIVE);
      expect(el.className).not.toContain(POSITIVE);
    }
    expect(screen.getByText("Matches the quote")).toBeInTheDocument();
  });

  it("hides the card when the backend reports no drift", () => {
    // Non-swap presets (claim/approve) have no quoted output, so the backend
    // returns null — the card is noise there and must not render.
    render(<VerdictPanel result={makeResult(null)} />);

    expect(screen.queryByText("State drift")).not.toBeInTheDocument();
    // The compact Drift field still degrades to the em dash.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("VerdictPanel — Execution Conflict card placement", () => {
  it("sits between Decision and In plain English without disturbing the existing cards", () => {
    const { container } = render(
      <VerdictPanel
        result={{ ...makeResult(-8.12, ["HIGH_STATE_CONFLICT"]), forecast: makeConflictForecast() }}
      />,
    );

    // The card renders inside the verdict panel…
    expect(screen.getByText("Execution conflict")).toBeInTheDocument();
    expect(screen.getByText("MEMPOOL VIEW")).toBeInTheDocument();

    // …in the required order: STATE DRIFT → STATUS → DECISION → EXECUTION
    // CONFLICT → IN PLAIN ENGLISH. Ordering is asserted on the rendered text
    // so a future move of the card fails this test on purpose.
    const text = container.textContent ?? "";
    expect(text.indexOf("State drift")).toBeGreaterThan(-1);
    expect(text.indexOf("State drift")).toBeLessThan(text.indexOf("Status"));
    expect(text.indexOf("Status")).toBeLessThan(text.indexOf("Decision"));
    expect(text.indexOf("Decision")).toBeLessThan(text.indexOf("Execution conflict"));
    expect(text.indexOf("Execution conflict")).toBeLessThan(text.indexOf("In plain English"));

    // Every pre-existing section is still present.
    expect(screen.getByText("Quoted output")).toBeInTheDocument();
    expect(screen.getByText("Simulated output")).toBeInTheDocument();
    expect(screen.getByText("Gas estimate")).toBeInTheDocument();
    expect(screen.getByText("Nonce")).toBeInTheDocument();
    expect(screen.getByText("Contract score")).toBeInTheDocument();
  });
});

describe("VerdictPanel — automatic recheck updates", () => {
  it("re-colours the drift from red to blue when a recheck returns positive drift", () => {
    // Initial verdict: negative drift (STALE_STATE).
    const { rerender } = render(<VerdictPanel result={makeResult(-10.68, ["STALE_STATE"])} />);
    expectEveryDrift("-10.68%", NEGATIVE);

    // A recheck poll lands with the pool moved the other way — app.tsx merges
    // the new outputDriftPercent into the same result and re-renders.
    rerender(<VerdictPanel result={makeResult(8.42)} />);

    expect(screen.queryAllByText("-10.68%")).toHaveLength(0);
    expectEveryDrift("+8.42%", POSITIVE);
    expect(screen.getByText("Better than quoted")).toBeInTheDocument();
  });

  it("re-colours the drift from blue to red when a recheck returns negative drift", () => {
    const { rerender } = render(<VerdictPanel result={makeResult(8.42)} />);
    expectEveryDrift("+8.42%", POSITIVE);

    rerender(<VerdictPanel result={makeResult(-10.68, ["STALE_STATE"])} />);

    expect(screen.queryAllByText("+8.42%")).toHaveLength(0);
    expectEveryDrift("-10.68%", NEGATIVE);
    expect(screen.getByText("Worse than quoted")).toBeInTheDocument();
    expect(screen.getByText("STALE_STATE")).toBeInTheDocument();
  });

  it("re-colours the drift from red back to neutral when a recheck returns zero drift", () => {
    const { rerender } = render(<VerdictPanel result={makeResult(-10.68, ["STALE_STATE"])} />);
    expectEveryDrift("-10.68%", NEGATIVE);

    rerender(<VerdictPanel result={makeResult(0)} />);

    const matches = screen.getAllByText("0.00%");
    for (const el of matches) {
      expect(el.className).toContain(NEUTRAL);
    }
    expect(screen.getByText("Matches the quote")).toBeInTheDocument();
    // The stale flag has cleared — no STALE_STATE status remains.
    expect(screen.queryByText("STALE_STATE")).not.toBeInTheDocument();
  });
});
