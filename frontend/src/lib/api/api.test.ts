import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeAlert, normalizeLedgerEntry, normalizeWatchlistItem } from "./normalize";
import { ApiError, apiFetch, qs } from "./client";
import type { WireAlert, WireLedgerEntry, WireWatchlistItem } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown, ok = status < 400) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("normalize — SQLite rows to app types", () => {
  it("converts alert 0|1 integer columns to real booleans", () => {
    const row: WireAlert = {
      id: "a1",
      contract_address: "0xabc",
      type: "reserve_drift",
      severity: "critical",
      message: "reserves moved 12%",
      drift_pct: 12.4,
      is_read: 0,
      dismissed: 1,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const alert = normalizeAlert(row);
    expect(alert.isRead).toBe(false);
    expect(alert.dismissed).toBe(true);
    expect(alert.driftPct).toBe(12.4);
    expect(alert.address).toBe("0xabc");
    // The snake_case keys must not leak through.
    expect(alert).not.toHaveProperty("is_read");
    expect(alert).not.toHaveProperty("contract_address");
  });

  it("keeps a null drift_pct null rather than coercing it to 0", () => {
    const row = {
      id: "a2",
      contract_address: "0xabc",
      type: "inactivity",
      severity: "info",
      message: "quiet",
      drift_pct: null,
      is_read: 1,
      dismissed: 0,
      created_at: "2026-01-01T00:00:00.000Z",
    } satisfies WireAlert;
    expect(normalizeAlert(row).driftPct).toBeNull();
    expect(normalizeAlert(row).isRead).toBe(true);
  });

  it("maps watchlist rows", () => {
    const row: WireWatchlistItem = {
      contract_address: "0xdef",
      watch_type: "auto",
      added_at: "2026-01-01T00:00:00.000Z",
      last_checked: null,
    };
    expect(normalizeWatchlistItem(row)).toEqual({
      address: "0xdef",
      watchType: "auto",
      addedAt: "2026-01-01T00:00:00.000Z",
      lastChecked: null,
    });
  });

  it("maps ledger rows including a not-yet-reported outcome", () => {
    const row: WireLedgerEntry = {
      id: "e1",
      tx_from: "0x1",
      tx_to: "0x2",
      tx_value: "0",
      policy_action: "ABORT",
      policy_reason: "simulation reverted",
      explanation: "This will fail.",
      user_action: null,
      outcome: null,
      tx_hash: null,
      risk_level: "CRITICAL",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const entry = normalizeLedgerEntry(row);
    expect(entry.action).toBe("ABORT");
    expect(entry.riskLevel).toBe("CRITICAL");
    expect(entry.userAction).toBeNull();
    expect(entry.outcome).toBeNull();
  });
});

describe("apiFetch — error mapping", () => {
  it("maps a 400 body to a ValidationError with its details", async () => {
    stubFetch(400, {
      error: "ValidationError",
      message: "from must be a valid hex address",
      details: [{ path: "tx.from", message: "from must be a valid hex address" }],
    });
    const err = await apiFetch("/api/evaluate").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.kind).toBe("ValidationError");
    expect(apiErr.status).toBe(400);
    expect(apiErr.details[0].path).toBe("tx.from");
    expect(apiErr.message).toBe("from must be a valid hex address");
  });

  it("maps the watchlist 409 to AlreadyWatching so it can be shown inline", async () => {
    stubFetch(409, { ok: false, error: "AlreadyWatching", message: "already watching" });
    const err = (await apiFetch("/api/watchlist").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("AlreadyWatching");
  });

  it("maps a 404 to NotFound", async () => {
    stubFetch(404, { error: "NotFound", message: "no such entry" });
    const err = (await apiFetch("/api/outcome").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("NotFound");
  });

  it("maps a 500 to InternalServerError", async () => {
    stubFetch(500, { error: "InternalServerError", message: "boom" });
    const err = (await apiFetch("/api/stats").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("InternalServerError");
  });

  it("reports an unreachable backend as a Network error, not a crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = (await apiFetch("/api/stats").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("Network");
    expect(err.message).toMatch(/Is it running\?/);
  });

  it("returns the parsed body on success", async () => {
    stubFetch(200, { status: "ok", service: "vantage-backend" });
    await expect(apiFetch("/health")).resolves.toEqual({
      status: "ok",
      service: "vantage-backend",
    });
  });

  it("survives a non-JSON error body instead of throwing a parse error", async () => {
    stubFetch(502, "<html>bad gateway</html>");
    const err = (await apiFetch("/api/stats").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("InternalServerError");
    expect(err.status).toBe(502);
  });
});

describe("qs", () => {
  it("drops undefined values and returns empty for no params", () => {
    expect(qs({ limit: 5, offset: undefined })).toBe("?limit=5");
    expect(qs({ a: undefined })).toBe("");
  });
});
