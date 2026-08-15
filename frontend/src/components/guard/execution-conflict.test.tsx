import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExecutionConflictCard } from "./execution-conflict";
import { explainConflict } from "../../lib/risk";
import type { ConflictEvidence, Forecast } from "../../lib/api";

/** Backend counts for a clean mempool: everything zero, real pending-block source. */
function makeEvidence(overrides: Partial<ConflictEvidence> = {}): ConflictEvidence {
  return {
    source: "pending-block",
    scannedAt: 1_700_000_000_000,
    competingTxCount: 0,
    competingSwapCount: 0,
    competingPoolWriterCount: 0,
    competingClaimCount: 0,
    pendingPoolSize: 0,
    excludedSameSenderCount: 0,
    excludedNonViableCount: 0,
    relevantTxs: [],
    ...overrides,
  };
}

function makeForecast(overrides: Partial<Forecast> = {}): Forecast {
  return {
    simulationSuccess: true,
    revertReason: null,
    simulatedOutput: "105000000000000000000",
    quotedOutput: "100000000000000000000",
    outputDriftPercent: null,
    gasEstimate: "21000",
    balanceSufficient: true,
    nonceCurrent: true,
    nonceIssue: null,
    contentionScore: 0.1,
    riskLevel: "LOW",
    flags: [],
    timestamp: 1_700_000_000_000,
    score: {
      scored: false,
      score: null,
      breakdown: { failureRate: 0, alertCount: 0, contentionStability: 1, sampleSize: 0 },
      lastUpdated: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("ExecutionConflictCard — discrete classifier states", () => {
  it("renders NONE as the active state for a clean mempool, with no chips", () => {
    render(
      <ExecutionConflictCard
        forecast={makeForecast({
          conflictScore: 0,
          conflictFlags: [],
          conflictEvidence: makeEvidence(),
        })}
      />,
    );

    // All three discrete states are shown; NONE is the emphasised one.
    const none = screen.getByText("NONE");
    expect(none.className).toContain("text-[color:var(--safe)]");
    expect(screen.getByText("POTENTIAL").className).toContain("text-text-secondary");
    expect(screen.getByText("HIGH").className).toContain("text-text-secondary");

    // Score renders as a plain number — never a percentage meter.
    expect(screen.getByText("Conflict score")).toBeInTheDocument();
    expect(screen.getByText("0.000")).toBeInTheDocument();

    // Zero counts hide every evidence chip.
    expect(screen.queryByText(/Competing transactions/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Competing swaps/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pool writers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Same-slot claims/)).not.toBeInTheDocument();
  });

  it("renders POTENTIAL as the active state with one competing swap", () => {
    render(
      <ExecutionConflictCard
        forecast={makeForecast({
          // Backend test fixture: a single competing swap → POTENTIAL (below the HIGH bar).
          conflictScore: 0.458,
          conflictFlags: ["POTENTIAL_STATE_CONFLICT"],
          conflictEvidence: makeEvidence({
            competingTxCount: 1,
            competingSwapCount: 1,
          }),
        })}
      />,
    );

    expect(screen.getByText("POTENTIAL").className).toContain("text-[color:var(--caution)]");
    expect(screen.getByText("NONE").className).toContain("text-text-secondary");
    expect(screen.getByText("0.458")).toBeInTheDocument();
    expect(screen.getByText("Competing swaps · 1")).toBeInTheDocument();
    expect(screen.getByText("Competing transactions · 1")).toBeInTheDocument();
  });

  it("renders HIGH as the active state with two competing swaps and a pool writer", () => {
    render(
      <ExecutionConflictCard
        forecast={makeForecast({
          // Backend test fixture: two competing swaps → HIGH_STATE_CONFLICT.
          conflictScore: 0.614,
          conflictFlags: ["HIGH_STATE_CONFLICT"],
          conflictEvidence: makeEvidence({
            competingTxCount: 3,
            competingSwapCount: 2,
            competingPoolWriterCount: 1,
          }),
        })}
      />,
    );

    expect(screen.getByText("HIGH").className).toContain("text-[color:var(--danger)]");
    expect(screen.getByText("POTENTIAL").className).toContain("text-text-secondary");
    expect(screen.getByText("0.614")).toBeInTheDocument();
    expect(screen.getByText("Competing swaps · 2")).toBeInTheDocument();
    expect(screen.getByText("Pool writers · 1")).toBeInTheDocument();
    // The third pending tx is not a swap or a pool writer — only the direct
    // evidence chips are shown, same-contract count included.
    expect(screen.getByText("Competing transactions · 3")).toBeInTheDocument();
  });

  it("renders nothing when the backend produced no evidence snapshot", () => {
    render(<ExecutionConflictCard forecast={makeForecast({ conflictEvidence: null })} />);

    expect(screen.queryByText("Execution conflict")).not.toBeInTheDocument();
  });
});

describe("ExecutionConflictCard — source indicator comes from the backend", () => {
  it("renders MEMPOOL VIEW for a pending-block scan", () => {
    render(
      <ExecutionConflictCard
        forecast={makeForecast({
          conflictScore: 0,
          conflictFlags: [],
          conflictEvidence: makeEvidence({ source: "pending-block" }),
        })}
      />,
    );

    expect(screen.getByText("MEMPOOL VIEW")).toBeInTheDocument();
  });

  it("renders LOG-DENSITY ESTIMATE for the logs fallback", () => {
    render(
      <ExecutionConflictCard
        forecast={makeForecast({
          // The fallback caps the score below the HIGH bar by construction.
          conflictScore: 0.31,
          conflictFlags: ["POTENTIAL_STATE_CONFLICT"],
          conflictEvidence: makeEvidence({
            source: "logs-fallback",
            error: "eth_getBlockByNumber failed",
          }),
        })}
      />,
    );

    expect(screen.getByText("LOG-DENSITY ESTIMATE")).toBeInTheDocument();
    // No mempool counts exist in the fallback — chips stay hidden.
    expect(screen.queryByText(/Competing swaps/)).not.toBeInTheDocument();
    // And the explanation says the estimate is weaker evidence, not a real view.
    expect(screen.getByText(/log density/)).toBeInTheDocument();
  });
});

describe("ExecutionConflictCard — recheck transitions", () => {
  it("moves NONE → POTENTIAL when a recheck lands new mempool evidence", () => {
    const { rerender } = render(
      <ExecutionConflictCard
        forecast={makeForecast({
          conflictScore: 0,
          conflictFlags: [],
          conflictEvidence: makeEvidence(),
        })}
      />,
    );
    expect(screen.getByText("NONE").className).toContain("text-[color:var(--safe)]");
    expect(screen.getByText("0.000")).toBeInTheDocument();

    // A recheck re-scans the mempool: one competitor appears. app.tsx merges
    // the fresh conflictScore + flags into the same result and re-renders.
    rerender(
      <ExecutionConflictCard
        forecast={makeForecast({
          conflictScore: 0.458,
          conflictFlags: ["POTENTIAL_STATE_CONFLICT"],
          conflictEvidence: makeEvidence({ competingTxCount: 1, competingSwapCount: 1 }),
        })}
      />,
    );

    expect(screen.getByText("POTENTIAL").className).toContain("text-[color:var(--caution)]");
    expect(screen.getByText("0.458")).toBeInTheDocument();
    expect(screen.queryByText("0.000")).not.toBeInTheDocument();
    expect(screen.getByText("Competing swaps · 1")).toBeInTheDocument();
  });

  it("moves POTENTIAL → HIGH as the mempool fills with racers", () => {
    const { rerender } = render(
      <ExecutionConflictCard
        forecast={makeForecast({
          conflictScore: 0.458,
          conflictFlags: ["POTENTIAL_STATE_CONFLICT"],
          conflictEvidence: makeEvidence({ competingTxCount: 1, competingSwapCount: 1 }),
        })}
      />,
    );

    rerender(
      <ExecutionConflictCard
        forecast={makeForecast({
          conflictScore: 0.614,
          conflictFlags: ["HIGH_STATE_CONFLICT"],
          conflictEvidence: makeEvidence({ competingTxCount: 2, competingSwapCount: 2 }),
        })}
      />,
    );

    expect(screen.getByText("HIGH").className).toContain("text-[color:var(--danger)]");
    expect(screen.getByText("0.614")).toBeInTheDocument();
  });

  it("moves HIGH → NONE when the mempool clears", () => {
    const { rerender } = render(
      <ExecutionConflictCard
        forecast={makeForecast({
          conflictScore: 0.614,
          conflictFlags: ["HIGH_STATE_CONFLICT"],
          conflictEvidence: makeEvidence({ competingTxCount: 2, competingSwapCount: 2 }),
        })}
      />,
    );

    rerender(
      <ExecutionConflictCard
        forecast={makeForecast({
          conflictScore: 0,
          conflictFlags: [],
          conflictEvidence: makeEvidence(),
        })}
      />,
    );

    expect(screen.getByText("NONE").className).toContain("text-[color:var(--safe)]");
    expect(screen.queryByText(/Competing swaps/)).not.toBeInTheDocument();
  });
});

describe("explainConflict — evidence-only explanations", () => {
  const flags = (f: Forecast["conflictFlags"]) => f;

  it("reports competing swaps against the same liquidity pool", () => {
    const text = explainConflict(
      flags(["HIGH_STATE_CONFLICT"]),
      makeEvidence({
        competingSwapCount: 2,
      }),
    );
    expect(text).toBe("2 competing swaps were detected against the same liquidity pool.");
  });

  it("reports reserve-mutating transactions", () => {
    const text = explainConflict(
      flags(["POTENTIAL_STATE_CONFLICT"]),
      makeEvidence({
        competingPoolWriterCount: 4,
      }),
    );
    expect(text).toBe("4 reserve-mutating transactions were detected against the same pool.");
  });

  it("reports a high probability of state changes from flags alone", () => {
    const text = explainConflict(flags(["HIGH_STATE_CONFLICT"]), makeEvidence());
    expect(text).toBe("A high probability of state changes before execution was detected.");
  });

  it("acknowledges the logs fallback as an estimate", () => {
    const text = explainConflict(
      flags(["POTENTIAL_STATE_CONFLICT"]),
      makeEvidence({
        source: "logs-fallback",
      }),
    );
    expect(text).toContain("log density on the target contract");
  });

  it("says the mempool is clear when there is no conflict", () => {
    const text = explainConflict(flags([]), makeEvidence());
    expect(text).toBe("No competing transactions were detected in the mempool.");
  });
});
