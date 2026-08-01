// Alert lifecycle — alerts must be able to end.
//
// Before this, an alert lived until a human dismissed it. One transient failure
// surge therefore forced every later verdict on that contract from PROCEED to
// WARN and held a flat 15 points off its score indefinitely.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDatabase,
  addToWatchlist,
  insertAlert,
  resolveAlerts,
  expireStaleAlerts,
  getActiveCriticalAlertCount,
  getAlerts,
  getAlertSummary,
  hasActiveAlert,
  pruneAutoWatchlist,
  getWatchlist,
} from "./ledger.js";

const A = "0x2222222222222222222222222222222222222222";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vantage-alerts-"));
  initDatabase(join(tmpDir, "alerts.db"));
  addToWatchlist(A, "manual");
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function raiseCritical(): void {
  insertAlert({
    contractAddress: A,
    type: "failure_surge",
    severity: "critical",
    message: "failures spiked",
  });
}

describe("resolveAlerts", () => {
  it("retracts an alert once its condition is gone", () => {
    raiseCritical();
    assert.equal(getActiveCriticalAlertCount(A), 1);

    const resolved = resolveAlerts(A, "failure_surge");

    assert.equal(resolved, 1);
    assert.equal(getActiveCriticalAlertCount(A), 0, "a resolved alert must stop biasing policy");
    assert.equal(hasActiveAlert(A, "failure_surge"), false);
    assert.equal(getAlerts().length, 0, "resolved alerts leave the queue");
  });

  it("is a no-op when there is nothing to resolve", () => {
    assert.equal(resolveAlerts(A, "failure_surge"), 0);
  });

  it("only resolves the named type", () => {
    raiseCritical();
    insertAlert({ contractAddress: A, type: "inactivity", severity: "info", message: "quiet" });

    resolveAlerts(A, "inactivity");

    assert.equal(hasActiveAlert(A, "failure_surge"), true);
    assert.equal(hasActiveAlert(A, "inactivity"), false);
  });

  it("lets the same condition raise a fresh alert if it returns", () => {
    raiseCritical();
    resolveAlerts(A, "failure_surge");
    // Dedup keys on undismissed alerts, so a resolved one must not block this.
    const second = insertAlert({
      contractAddress: A,
      type: "failure_surge",
      severity: "critical",
      message: "failures spiked again",
    });
    assert.ok(second, "a recurrence must be able to raise a new alert");
  });
});

describe("expireStaleAlerts", () => {
  it("leaves fresh alerts alone", () => {
    raiseCritical();
    assert.equal(expireStaleAlerts(60 * 60_000), 0);
    assert.equal(getActiveCriticalAlertCount(A), 1);
  });

  it("retires alerts nobody has re-observed", async () => {
    raiseCritical();
    // created_at has millisecond resolution, so give the clock room to move
    // past it before asking for anything strictly older than the cutoff.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(expireStaleAlerts(1), 1);
    assert.equal(getActiveCriticalAlertCount(A), 0);
  });
});

describe("getAlertSummary", () => {
  it("reports every field over active alerts, so they cannot disagree", () => {
    raiseCritical();
    insertAlert({ contractAddress: A, type: "inactivity", severity: "info", message: "quiet" });

    resolveAlerts(A, "failure_surge");
    const summary = getAlertSummary();

    // total used to count dismissed rows while critical did not, so one
    // response could claim total 2, critical 0 and bySeverity.critical 1.
    assert.equal(summary.total, 1);
    assert.equal(summary.critical, 0);
    assert.equal(summary.bySeverity.critical ?? 0, 0);
    assert.equal(summary.bySeverity.info, 1);
    assert.equal(summary.unread, 1);
  });
});

describe("pruneAutoWatchlist", () => {
  it("evicts the oldest auto entries beyond the cap and keeps manual ones", () => {
    // Letters only — digits would collide with the manual fixture address A.
    for (const c of ["a", "b", "c", "d", "e"]) {
      assert.equal(addToWatchlist(`0x${c.repeat(40)}`, "auto"), true);
    }
    const evicted = pruneAutoWatchlist(2);

    const remaining = getWatchlist();
    const autos = remaining.filter((r) => r.watch_type === "auto");
    assert.equal(evicted, 3);
    assert.equal(autos.length, 2, "auto entries are capped");
    assert.ok(
      remaining.some((r) => r.contract_address.toLowerCase() === A.toLowerCase()),
      "a manually watched contract must never be evicted",
    );
  });

  it("does nothing when under the cap", () => {
    addToWatchlist("0x3333333333333333333333333333333333333333", "auto");
    assert.equal(pruneAutoWatchlist(10), 0);
  });
});
