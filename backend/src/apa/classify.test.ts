// classifyTx — the distinction the endpoint exists to make.
//
// A null receipt can mean "still propagating", "stuck", or "dropped", and an
// unreachable node looks like all three. Getting this wrong is not cosmetic:
// telling a user their confirmed transaction was DROPPED invites them to
// broadcast a duplicate.
//
// RPC_URL is set before any import because config.ts reads process.env at
// module load and policy.ts destructures it once — importing either first
// would pin the real testnet URL for the whole file.
process.env.RPC_URL = "http://127.0.0.1:1"; // nothing listens here

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PSGForecast } from "../psg/forecast.js";

const { classifyTx, decidePolicy } = await import("./policy.js");

const HASH = `0x${"a".repeat(64)}` as const;

function forecast(over: Partial<PSGForecast> = {}): PSGForecast {
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
    contentionScore: null,
    riskLevel: "LOW",
    flags: [],
    timestamp: Date.now(),
    ...over,
  };
}

describe("decidePolicy — no fabricated aborts", () => {
  it("does not claim a revert for a LOW forecast carrying flags", () => {
    // This fell through every branch into the CRITICAL tail and returned
    // ABORT "Simulation reverted: unknown revert" for a transaction whose
    // simulation had succeeded.
    const result = decidePolicy(
      forecast({ riskLevel: "LOW", flags: ["WATCHDOG_CRITICAL_ALERTS"] }),
    );
    assert.notEqual(result.action, "ABORT");
    assert.doesNotMatch(
      result.reason,
      /Simulation reverted/,
      "must not assert a revert that never happened",
    );
    assert.match(result.reason, /WATCHDOG_CRITICAL_ALERTS/);
  });

  it("still aborts on a genuine CRITICAL revert", () => {
    const result = decidePolicy(
      forecast({
        riskLevel: "CRITICAL",
        simulationSuccess: false,
        revertReason: "SlotAlreadyClaimed(1)",
        flags: ["REVERT"],
      }),
    );
    assert.equal(result.action, "ABORT");
    assert.match(result.reason, /SlotAlreadyClaimed/);
  });

  it("proceeds only when nothing at all is flagged", () => {
    assert.equal(decidePolicy(forecast()).action, "PROCEED");
  });
});

describe("classifyTx — an unreachable node is never evidence", () => {
  it("reports NULL_PENDING, not DROPPED, when the RPC cannot be reached", async () => {
    // Old enough that the elapsed-time branch would have returned DROPPED
    // ("Resubmit it") purely because the node was unreachable.
    const report = await classifyTx(HASH, Date.now() - 10 * 60_000);

    assert.equal(
      report.status,
      "NULL_PENDING",
      `an RPC failure must not be reported as ${report.status}`,
    );
    assert.doesNotMatch(report.recommendation, /Resubmit/i);
    assert.ok(report.secondsPending >= 600, "elapsed time still derives from submittedAt");
  });

  it("never puts an infrastructure message in revertReason", async () => {
    const report = await classifyTx(HASH, Date.now() - 1000);
    // revertReason means "the EVM reverted with this string" — an RPC problem
    // rendered under a status badge as a revert reason is a lie.
    assert.equal(report.revertReason, undefined);
  });

  it("derives elapsed time from the caller's timestamp, not from now", async () => {
    const fresh = await classifyTx(HASH, Date.now());
    const old = await classifyTx(HASH, Date.now() - 120_000);
    assert.equal(fresh.secondsPending, 0);
    assert.ok(old.secondsPending >= 120, "a 2-minute-old tx must not read as 0s pending");
  });
});
