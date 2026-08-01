// Address casing — every lookup must find rows written with different casing.
//
// Wallets hand out EIP-55 checksummed addresses; dashboards and config
// constants are usually lowercase. SQLite compares TEXT byte-wise, so before
// normalization the same contract written one way was invisible to a query
// written the other — silently zeroing scores, history and, worst, the
// critical-alert count that biases policy.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PSGForecast } from "../psg/forecast.js";
import {
  initDatabase,
  recordEntry,
  countEvaluations,
  getEntriesForContract,
  getRecentEntries,
  addToWatchlist,
  removeFromWatchlist,
  insertAlert,
  getActiveCriticalAlertCount,
  getAlerts,
  hasActiveAlert,
} from "./ledger.js";

const FROM = "0x1111111111111111111111111111111111111111";
// The same contract, as a wallet would send it vs as a config file stores it.
const CHECKSUMMED = "0x1712beC5cD3F8F7a47CB0dD322f9DC9209423df4";
const LOWERCASE = CHECKSUMMED.toLowerCase();
const UPPERCASE = "0x1712BEC5CD3F8F7A47CB0DD322F9DC9209423DF4";

function forecast(): PSGForecast {
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
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vantage-case-"));
  initDatabase(join(tmpDir, "case.db"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("ledger — address casing", () => {
  it("counts an evaluation written checksummed when queried lowercase", () => {
    recordEntry({
      txFrom: FROM,
      txTo: CHECKSUMMED,
      txData: "0x",
      txValue: "0",
      forecast: forecast(),
      policy: { action: "PROCEED", reason: "test" },
      explanation: "test",
    });

    // This returned 0 before normalization — the score endpoint's exact path.
    assert.equal(countEvaluations(LOWERCASE), 1);
    assert.equal(countEvaluations(UPPERCASE), 1);
    assert.equal(countEvaluations(CHECKSUMMED), 1);
  });

  it("finds contract history regardless of the casing used to query", () => {
    recordEntry({
      txFrom: FROM,
      txTo: LOWERCASE,
      txData: "0x",
      txValue: "0",
      forecast: forecast(),
      policy: { action: "ABORT", reason: "test" },
      explanation: "test",
    });

    assert.equal(getEntriesForContract(CHECKSUMMED, 60).length, 1);
    assert.equal(getRecentEntries({ contract: UPPERCASE }).total, 1);
  });

  it("treats a checksummed and lowercase watchlist entry as one contract", () => {
    assert.equal(addToWatchlist(CHECKSUMMED, "auto"), true);
    // Same contract, different casing — must not create a second row.
    assert.equal(addToWatchlist(LOWERCASE, "manual"), false);
    assert.equal(removeFromWatchlist(UPPERCASE), true);
  });

  it("counts critical alerts across casings — the watchdog policy bias", () => {
    addToWatchlist(LOWERCASE, "auto");
    insertAlert({
      contractAddress: CHECKSUMMED,
      type: "failure_surge",
      severity: "critical",
      message: "test",
    });

    // evaluate.ts calls this with tx.to straight off the wire. A miss here
    // means a contract with open critical alerts is treated as clean.
    assert.equal(getActiveCriticalAlertCount(LOWERCASE), 1);
    assert.equal(getActiveCriticalAlertCount(UPPERCASE), 1);
    assert.equal(hasActiveAlert(UPPERCASE, "failure_surge"), true);
    assert.equal(getAlerts({ address: UPPERCASE }).length, 1);
  });

  it("dedups alerts across casings instead of raising one per casing", () => {
    addToWatchlist(LOWERCASE, "auto");
    const first = insertAlert({
      contractAddress: LOWERCASE,
      type: "reserve_drift",
      severity: "warning",
      message: "a",
    });
    const second = insertAlert({
      contractAddress: CHECKSUMMED,
      type: "reserve_drift",
      severity: "warning",
      message: "b",
    });
    assert.ok(first, "first alert should insert");
    assert.equal(second, null, "same alert in different casing must dedup");
  });
});
