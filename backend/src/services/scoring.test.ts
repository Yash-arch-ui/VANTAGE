// Vantage Score — deterministic unit tests over a throwaway SQLite DB seeded
// through the real ledger functions (recordEntry / updateOutcome / insertAlert).
// No network, no mocks: the fixtures are the same rows computeScore aggregates.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PSGForecast } from "../psg/forecast.js";
import type { PolicyResult } from "../apa/policy.js";
import { initDatabase, recordEntry, updateOutcome, insertAlert, addToWatchlist } from "../em/ledger.js";
import { computeScore } from "./scoring.js";

const FROM = "0x1111111111111111111111111111111111111111";
const A = "0x2222222222222222222222222222222222222222";
const B = "0x3333333333333333333333333333333333333333";

function baseForecast(contention?: number | null): PSGForecast {
  return {
    simulationSuccess: true,
    revertReason: null,
    simulatedOutput: "1",
    quotedOutput: null,
    outputDriftPercent: null,
    gasEstimate: "1",
    balanceSufficient: true,
    nonceCurrent: true,
    nonceIssue: null,
    contentionScore: contention ?? null,
    riskLevel: "LOW",
    flags: [],
    timestamp: Date.now(),
  };
}

let tmpDir: string;

function record(
  txTo: string,
  opts: { action?: PolicyResult["action"]; contention?: number | null; outcome?: string | null } = {},
): void {
  const policy: PolicyResult = { action: opts.action ?? "PROCEED", reason: "test" };
  const id = recordEntry({
    txFrom: FROM,
    txTo,
    txData: "0x",
    txValue: "0",
    forecast: baseForecast(opts.contention),
    policy,
    explanation: "test",
  });
  if (opts.outcome) updateOutcome(id!, "SIGNED", opts.outcome, null);
}

function seedClean(txTo: string, n = 5, contention: number | null = null): void {
  for (let i = 0; i < n; i++) record(txTo, { contention });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vantage-score-"));
  initDatabase(join(tmpDir, "score.db"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("computeScore — unscored contracts", () => {
  it("never-evaluated contract returns a distinct not-yet-scored response (not 100)", () => {
    const r = computeScore(A);
    assert.equal(r.scored, false);
    if (r.scored) return;
    assert.equal(r.score, null);
    assert.equal(r.message, "not yet scored");
    assert.equal(r.breakdown.sampleSize, 0);
  });
});

describe("computeScore — clean history", () => {
  it("scores 100 with an accurate breakdown for a clean, well-sampled contract", () => {
    seedClean(A);
    const r = computeScore(A);
    assert.equal(r.scored, true);
    if (!r.scored) return;
    assert.equal(r.score, 100);
    assert.equal(r.breakdown.failureRate, 0);
    assert.equal(r.breakdown.alertCount, 0);
    assert.equal(r.breakdown.contentionStability, 0);
    assert.equal(r.breakdown.sampleSize, 5);
    assert.equal(r.lastUpdated.length, 24); // ISO 8601 timestamp present
  });
});

describe("computeScore — failure rate", () => {
  it("deducts proportionally to the 24h failure rate (50% → −20)", () => {
    // 3 failures counted two ways — ABORT policy AND a FAILED outcome both count.
    record(A, { action: "ABORT" });
    record(A, { action: "ABORT" });
    record(A, { action: "PROCEED", outcome: "FAILED" });
    record(A, { action: "PROCEED", outcome: "CONFIRMED" });
    record(A, { action: "PROCEED" });
    record(A, { action: "PROCEED" });
    const r = computeScore(A);
    assert.equal(r.scored, true);
    if (!r.scored) return;
    assert.equal(r.breakdown.failureRate, 0.5);
    assert.equal(r.score, 80); // 100 − 40 × 0.5
  });
});

describe("computeScore — alerts", () => {
  it("deducts more for a critical alert than a warning", () => {
    seedClean(A);
    addToWatchlist(A, "auto"); // alerts FK to a watched contract — same as the real watchdog flow
    insertAlert({ contractAddress: A, type: "failure_surge", severity: "critical", message: "crit" });
    seedClean(B);
    addToWatchlist(B, "auto");
    insertAlert({ contractAddress: B, type: "contention_spike", severity: "warning", message: "warn" });
    const ra = computeScore(A);
    const rb = computeScore(B);
    assert.equal(ra.scored && rb.scored, true);
    if (!ra.scored || !rb.scored) return;
    assert.equal(ra.score, 85); // 100 − 15 (critical)
    assert.equal(rb.score, 95); // 100 − 5 (warning)
  });

  it("caps the alert deduction at 30", () => {
    seedClean(A);
    addToWatchlist(A, "auto");
    insertAlert({ contractAddress: A, type: "a", severity: "critical", message: "" });
    insertAlert({ contractAddress: A, type: "b", severity: "critical", message: "" });
    insertAlert({ contractAddress: A, type: "c", severity: "warning", message: "" });
    insertAlert({ contractAddress: A, type: "d", severity: "info", message: "" });
    const r = computeScore(A);
    assert.equal(r.scored, true);
    if (!r.scored) return;
    assert.equal(r.breakdown.alertCount, 36); // 15 + 15 + 5 + 1
    assert.equal(r.score, 70); // 100 − min(30, 36)
  });
});

describe("computeScore — contention", () => {
  it("deducts from a passed-in contention score", () => {
    seedClean(A);
    const rHigh = computeScore(A, 1.0);
    const rLow = computeScore(A, 0.2);
    assert.equal(rHigh.scored && rLow.scored, true);
    if (!rHigh.scored || !rLow.scored) return;
    assert.equal(rHigh.breakdown.contentionStability, 1);
    assert.equal(rHigh.score, 85); // 100 − 15
    assert.equal(rLow.score, 97); // 100 − 3
  });

  it("reads persisted contention from evaluation history when none is passed", () => {
    seedClean(A, 5, 1.0); // every evaluation observed contention 1.0
    const r = computeScore(A);
    assert.equal(r.scored, true);
    if (!r.scored) return;
    assert.equal(r.breakdown.contentionStability, 1);
    assert.equal(r.score, 85);
  });
});

describe("computeScore — sample size", () => {
  it("applies a flat −15 confidence penalty for a thin history (sampleSize < 5)", () => {
    seedClean(A, 3);
    const r = computeScore(A);
    assert.equal(r.scored, true);
    if (!r.scored) return;
    assert.equal(r.breakdown.sampleSize, 3);
    assert.equal(r.score, 85); // 100 − 15
  });
});

describe("computeScore — clamp", () => {
  it("worst case floors at 0, never negative", () => {
    record(A, { action: "ABORT" });
    record(A, { action: "ABORT" });
    addToWatchlist(A, "auto");
    insertAlert({ contractAddress: A, type: "a", severity: "critical", message: "" });
    insertAlert({ contractAddress: A, type: "b", severity: "critical", message: "" });
    const r = computeScore(A, 1.0);
    assert.equal(r.scored, true);
    if (!r.scored) return;
    assert.equal(r.score, 0); // 100 − 40 − 30 − 15 − 15 = 0
  });
});
