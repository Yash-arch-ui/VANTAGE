import { describe, it, expect } from "vitest";
import { formatToken, formatPercent, formatDriftPercent, formatGas, shortAddress, relativeTime } from "./format";
import { actionTone, riskTone, watchTone, scoreTone, actionLabel, watchStatusLabel } from "./risk";
import type { PolicyAction, RiskLevel, TxWatchStatus } from "./api";

describe("format — null is a normal answer, not a crash", () => {
  it("renders an em dash for every absent value", () => {
    // The backend is fail-soft and returns null for anything it could not
    // compute, so this is the common case rather than an edge case.
    expect(formatToken(null)).toBe("—");
    expect(formatToken(undefined)).toBe("—");
    expect(formatPercent(null)).toBe("—");
    expect(formatGas(null)).toBe("—");
  });

  it("survives values that are not parseable as a bigint", () => {
    expect(formatToken("not-a-number")).toBe("—");
    expect(formatGas("1.5")).toBe("—");
  });

  it("does not report a non-zero amount as zero", () => {
    // 1 wei formatted with 4 decimals would round to "0.0000", which reads as
    // nothing at all.
    expect(formatToken("1")).toBe("<0.0001");
  });

  it("signs percentages so a gain and a loss are distinguishable", () => {
    expect(formatPercent(8.333)).toBe("+8.33%");
    expect(formatPercent(-8.333)).toBe("-8.33%");
    expect(formatPercent(NaN)).toBe("—");
  });

  it("renders drift unsigned — the colour carries the direction", () => {
    // Signed values from the backend must render as a clean magnitude so the
    // red/blue colouring is the only signal for direction.
    expect(formatDriftPercent(10.5)).toBe("10.50%");
    expect(formatDriftPercent(-22.67)).toBe("22.67%");
    expect(formatDriftPercent(0)).toBe("0.00%");
    expect(formatDriftPercent(null)).toBe("—");
    expect(formatDriftPercent(NaN)).toBe("—");
  });

  it("shortens addresses without mangling short strings", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortAddress("0xabc")).toBe("0xabc");
  });

  it("reads a server timestamp as UTC and never goes negative", () => {
    expect(relativeTime(new Date().toISOString())).toMatch(/^\d+s ago$/);
    // A clock skew that puts the server slightly ahead must not render "-3s".
    expect(relativeTime(new Date(Date.now() + 5_000).toISOString())).toBe("0s ago");
    expect(relativeTime("nonsense")).toBe("—");
  });
});

describe("risk — every state maps to a tone and a label", () => {
  it("covers every policy action", () => {
    const actions: PolicyAction[] = [
      "PROCEED",
      "WARN",
      "HOLD_AND_RECHECK",
      "SUGGEST_ADJUSTMENT",
      "ABORT",
    ];
    for (const a of actions) {
      expect(actionTone(a)).toBeDefined();
      expect(actionLabel[a]).toBeTruthy();
    }
    // The triad must stay semantic: proceed is safe, abort is danger.
    expect(actionTone("PROCEED")).toBe("safe");
    expect(actionTone("ABORT")).toBe("danger");
  });

  it("covers every risk level and watch status", () => {
    const levels: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    for (const l of levels) expect(riskTone(l)).toBeDefined();

    const statuses: TxWatchStatus[] = ["CONFIRMED", "FAILED", "NULL_PENDING", "STUCK", "DROPPED"];
    for (const s of statuses) {
      expect(watchTone(s)).toBeDefined();
      expect(watchStatusLabel[s]).toBeTruthy();
    }
  });

  it("bands scores the same way it bands actions", () => {
    expect(scoreTone(95)).toBe("safe");
    expect(scoreTone(60)).toBe("caution");
    expect(scoreTone(10)).toBe("danger");
    expect(scoreTone(0)).toBe("danger");
  });
});
