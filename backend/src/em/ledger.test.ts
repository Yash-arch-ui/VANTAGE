// getRecentEntries — the audit-timeline query behind GET /api/ledger.
// Seeded through the real recordEntry/updateOutcome path against a throwaway
// SQLite file, so the fixtures are exactly the rows the API would serve.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PSGForecast } from "../psg/forecast.js";
import type { PolicyResult } from "../apa/policy.js";
import { initDatabase, recordEntry, updateOutcome, getRecentEntries } from "./ledger.js";

const FROM = "0x1111111111111111111111111111111111111111";
const A = "0x2222222222222222222222222222222222222222";
const B = "0x3333333333333333333333333333333333333333";

function forecast(riskLevel: PSGForecast["riskLevel"]): PSGForecast {
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
    riskLevel,
    flags: [],
    timestamp: Date.now(),
  };
}

function record(
  txTo: string,
  opts: { action?: PolicyResult["action"]; riskLevel?: PSGForecast["riskLevel"] } = {},
): string {
  const policy: PolicyResult = { action: opts.action ?? "PROCEED", reason: "test" };
  const id = recordEntry({
    txFrom: FROM,
    txTo,
    txData: "0xdeadbeef",
    txValue: "0",
    forecast: forecast(opts.riskLevel ?? "LOW"),
    policy,
    explanation: "test explanation",
  });
  assert.ok(id, "recordEntry should return an id");
  return id!;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vantage-ledger-"));
  initDatabase(join(tmpDir, "ledger.db"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("getRecentEntries — shape", () => {
  it("returns an empty page rather than throwing when nothing is recorded", () => {
    const { items, total } = getRecentEntries();
    assert.deepEqual(items, []);
    assert.equal(total, 0);
  });

  it("projects riskLevel out of the forecast and omits the raw blob", () => {
    record(A, { riskLevel: "CRITICAL", action: "ABORT" });
    const { items } = getRecentEntries();
    assert.equal(items.length, 1);
    assert.equal(items[0].risk_level, "CRITICAL");
    assert.equal(items[0].policy_action, "ABORT");
    assert.equal(items[0].tx_to, A);
    assert.ok(!("forecast_json" in items[0]), "forecast_json must not be shipped to clients");
    assert.ok(!("tx_data" in items[0]), "tx_data is not part of the timeline projection");
  });

  it("carries the outcome fields once they are attached", () => {
    const id = record(A);
    updateOutcome(id, "SIGNED", "CONFIRMED", `0x${"a".repeat(64)}`);
    const { items } = getRecentEntries();
    assert.equal(items[0].user_action, "SIGNED");
    assert.equal(items[0].outcome, "CONFIRMED");
    assert.equal(items[0].tx_hash, `0x${"a".repeat(64)}`);
  });
});

describe("getRecentEntries — paging", () => {
  it("clamps an oversized limit to 100 and a zero/negative limit to 1", () => {
    for (let i = 0; i < 3; i++) record(A);
    assert.equal(getRecentEntries({ limit: 5000 }).items.length, 3);
    assert.equal(getRecentEntries({ limit: 0 }).items.length, 1);
    assert.equal(getRecentEntries({ limit: -7 }).items.length, 1);
  });

  it("reports total for the whole filter, not just the page", () => {
    for (let i = 0; i < 7; i++) record(A);
    const page = getRecentEntries({ limit: 2 });
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 7);
  });

  it("offset walks the result set without repeating rows", () => {
    for (let i = 0; i < 5; i++) record(A);
    const first = getRecentEntries({ limit: 2, offset: 0 }).items.map((r) => r.id);
    const second = getRecentEntries({ limit: 2, offset: 2 }).items.map((r) => r.id);
    assert.equal(new Set([...first, ...second]).size, 4, "pages must not overlap");
  });
});

describe("getRecentEntries — filtering", () => {
  it("narrows to a single contract", () => {
    record(A);
    record(A);
    record(B);
    const page = getRecentEntries({ contract: B });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].tx_to, B);
  });

  it("rejects a malformed address instead of interpolating it into SQL", () => {
    record(A);
    const page = getRecentEntries({ contract: "'; DROP TABLE execution_ledger; --" });
    assert.deepEqual(page.items, []);
    assert.equal(page.total, 0);
    // The table must still be intact.
    assert.equal(getRecentEntries().total, 1);
  });
});
