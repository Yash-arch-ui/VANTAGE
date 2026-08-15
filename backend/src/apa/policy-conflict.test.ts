// ECA — policy integration tests for decidePolicy / explainPolicy.
//
// Stage 3 rules under test:
//   HIGH_STATE_CONFLICT     → HOLD_AND_RECHECK (reuses the existing hold loop)
//   POTENTIAL_STATE_CONFLICT→ WARN (via the MEDIUM risk tier)
//   Nonce ABORT conditions  → retain higher precedence than any conflict flag
//   Drift / approval behavior → unchanged
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { type PSGForecast } from "../psg/forecast.js";
import { decidePolicy } from "./policy.js";

function base(overrides: Partial<PSGForecast> = {}): PSGForecast {
  return {
    simulationSuccess: false,
    revertReason: null,
    simulatedOutput: null,
    quotedOutput: null,
    outputDriftPercent: null,
    gasEstimate: null,
    balanceSufficient: null,
    nonceCurrent: null,
    nonceIssue: null,
    contentionScore: null,
    conflictScore: null,
    conflictFlags: [],
    conflictEvidence: null,
    riskLevel: "LOW",
    flags: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

// The explainer must take its deterministic template path — never the AI call.
before(() => {
  process.env.GEMINI_API_KEY = "";
});
after(() => {
  delete process.env.GEMINI_API_KEY;
});

describe("decidePolicy — ECA conflict flags", () => {
  it("HIGH + HIGH_STATE_CONFLICT → HOLD_AND_RECHECK with the conflict score in the reason", () => {
    const r = decidePolicy(
      base({ riskLevel: "HIGH", flags: ["HIGH_STATE_CONFLICT"], conflictScore: 0.779 }),
    );
    assert.equal(r.action, "HOLD_AND_RECHECK");
    assert.ok(r.reason.toLowerCase().includes("conflict"));
    assert.ok(r.reason.includes("0.78"), "reason carries the conflict score");
  });

  it("MEDIUM + POTENTIAL_STATE_CONFLICT → WARN with the flag listed", () => {
    const r = decidePolicy(
      base({ riskLevel: "MEDIUM", flags: ["POTENTIAL_STATE_CONFLICT"], conflictScore: 0.401 }),
    );
    assert.equal(r.action, "WARN");
    assert.ok(r.reason.includes("POTENTIAL_STATE_CONFLICT"));
  });
});

describe("decidePolicy — nonce ABORT precedence over conflict", () => {
  it("NONCE_GAP + HIGH_STATE_CONFLICT → ABORT (never downgraded to a hold)", () => {
    const r = decidePolicy(
      base({ riskLevel: "HIGH", flags: ["NONCE_GAP", "HIGH_STATE_CONFLICT"], conflictScore: 0.9 }),
    );
    assert.equal(r.action, "ABORT");
    assert.ok(r.reason.includes("nonce gap"));
  });

  it("NONCE_STALE + HIGH_STATE_CONFLICT → ABORT", () => {
    const r = decidePolicy(
      base({ riskLevel: "HIGH", flags: ["NONCE_STALE", "HIGH_STATE_CONFLICT"], conflictScore: 0.9 }),
    );
    assert.equal(r.action, "ABORT");
    assert.ok(r.reason.includes("stale nonce"));
  });

  it("LOW_BALANCE + HIGH_STATE_CONFLICT → ABORT", () => {
    const r = decidePolicy(
      base({ riskLevel: "HIGH", flags: ["LOW_BALANCE", "HIGH_STATE_CONFLICT"], conflictScore: 0.9 }),
    );
    assert.equal(r.action, "ABORT");
    assert.ok(r.reason.includes("balance"));
  });
});

describe("decidePolicy — conflict vs other HIGH conditions", () => {
  it("STALE_STATE + HIGH_STATE_CONFLICT → HOLD_AND_RECHECK (conflict outranks drift)", () => {
    // Drift is a WARN condition; an active state conflict is resolvable by
    // waiting, so the conflict hold wins — mirroring how HIGH_CONTENTION
    // already outranks STALE_STATE.
    const r = decidePolicy(
      base({
        riskLevel: "HIGH",
        flags: ["STALE_STATE", "HIGH_STATE_CONFLICT"],
        outputDriftPercent: -8.5,
        conflictScore: 0.779,
      }),
    );
    assert.equal(r.action, "HOLD_AND_RECHECK");
    assert.ok(r.reason.toLowerCase().includes("conflict"));
  });

  it("HIGH_CONTENTION + HIGH_STATE_CONFLICT → HOLD_AND_RECHECK", () => {
    const r = decidePolicy(
      base({
        riskLevel: "HIGH",
        flags: ["HIGH_CONTENTION", "HIGH_STATE_CONFLICT"],
        contentionScore: 0.85,
        conflictScore: 0.779,
      }),
    );
    assert.equal(r.action, "HOLD_AND_RECHECK");
  });

  it("HIGH_STATE_CONFLICT alone → HOLD_AND_RECHECK (no contention required)", () => {
    const r = decidePolicy(
      base({ riskLevel: "HIGH", flags: ["HIGH_STATE_CONFLICT"], conflictScore: 0.779, contentionScore: 0 }),
    );
    assert.equal(r.action, "HOLD_AND_RECHECK");
  });

  it("clean transaction → PROCEED (unchanged)", () => {
    const r = decidePolicy(base({ riskLevel: "LOW", flags: [] }));
    assert.equal(r.action, "PROCEED");
  });
});

describe("explainPolicy — conflict wording (deterministic template)", () => {
  it("HOLD_AND_RECHECK with HIGH_STATE_CONFLICT mentions competing pending transactions", async () => {
    const { explainPolicy } = await import("./policy.js");
    const forecast = base({
      riskLevel: "HIGH",
      flags: ["HIGH_STATE_CONFLICT"],
      conflictScore: 0.779,
    });
    const text = await explainPolicy(forecast, {
      action: "HOLD_AND_RECHECK",
      reason: "State conflict",
    });
    assert.ok(text.toLowerCase().includes("conflict") || text.toLowerCase().includes("competing"));
    assert.ok(text.includes("0.78"), "explainer carries the conflict score");
  });

  it("HOLD_AND_RECHECK without conflict keeps the contention wording", async () => {
    const { explainPolicy } = await import("./policy.js");
    const forecast = base({
      riskLevel: "HIGH",
      flags: ["HIGH_CONTENTION"],
      contentionScore: 0.85,
    });
    const text = await explainPolicy(forecast, {
      action: "HOLD_AND_RECHECK",
      reason: "Contention",
    });
    assert.ok(text.toLowerCase().includes("contention"));
    assert.ok(!text.toLowerCase().includes("conflict"));
  });
});
