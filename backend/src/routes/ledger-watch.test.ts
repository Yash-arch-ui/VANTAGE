// HTTP-level tests for the two routes the frontend depends on:
// GET /api/ledger (audit timeline) and GET /api/watch/:txHash (tx status).
//
// The real app is imported and bound to an ephemeral port — no mocks, no
// supertest. DATABASE_PATH and VANTAGE_NO_LISTEN are set before the import so
// server.ts opens a throwaway DB and does not bind its own port.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { Express } from "express";

const tmpDir = mkdtempSync(join(tmpdir(), "vantage-routes-"));
process.env.DATABASE_PATH = join(tmpDir, "routes.db");
process.env.VANTAGE_NO_LISTEN = "1";

let server: Server;
let base: string;

before(async () => {
  const { app } = (await import("../server.js")) as { app: Express };
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port bound");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("GET /api/ledger", () => {
  it("is mounted and returns a page envelope", async () => {
    const res = await fetch(`${base}/api/ledger`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    assert.ok(Array.isArray(body.items));
    assert.equal(typeof body.total, "number");
  });

  it("400s on a malformed contract filter", async () => {
    const res = await fetch(`${base}/api/ledger?contract=nope`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; details: unknown[] };
    assert.equal(body.error, "ValidationError");
    assert.ok(body.details.length > 0);
  });

  it("400s on a non-numeric limit rather than silently ignoring it", async () => {
    const res = await fetch(`${base}/api/ledger?limit=all`);
    assert.equal(res.status, 400);
  });

  it("rejects limit=0 instead of silently returning one row", async () => {
    const res = await fetch(`${base}/api/ledger?limit=0`);
    assert.equal(res.status, 400);
  });

  it("accepts a well-formed contract filter", async () => {
    const res = await fetch(`${base}/api/ledger?contract=0x${"2".repeat(40)}&limit=5&offset=0`);
    assert.equal(res.status, 200);
  });
});

describe("GET /api/watch/:txHash", () => {
  it("400s on a hash that is not 32 bytes", async () => {
    const res = await fetch(`${base}/api/watch/0xabc`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "ValidationError");
  });

  it("400s on a non-numeric `since`", async () => {
    const res = await fetch(`${base}/api/watch/0x${"a".repeat(64)}?since=yesterday`);
    assert.equal(res.status, 400);
  });

  it("requires `since` — without it every status collapses to propagating", async () => {
    // Defaulting it to now made elapsed time permanently zero, which rendered
    // DROPPED and STUCK unreachable and reported an hours-old evicted
    // transaction as "keep waiting" forever.
    const res = await fetch(`${base}/api/watch/0x${"a".repeat(64)}`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "ValidationError");
  });

  it("rejects a `since` far in the past", async () => {
    // since=0 made a one-second-old transaction look hours old and returned
    // "DROPPED — resubmit it", inviting a duplicate broadcast.
    const res = await fetch(`${base}/api/watch/0x${"a".repeat(64)}?since=0`);
    assert.equal(res.status, 400);
  });

  it("rejects a `since` in the future", async () => {
    const future = Date.now() + 10 * 60_000;
    const res = await fetch(`${base}/api/watch/0x${"a".repeat(64)}?since=${future}`);
    assert.equal(res.status, 400);
  });

  it("returns a classification for an unknown hash instead of erroring", async () => {
    // An unknown hash submitted long ago is DROPPED; the point of the assertion
    // is that the endpoint always answers with a usable status + recommendation
    // and never 500s, even when the RPC is unreachable in CI.
    const since = Date.now() - 60_000;
    const res = await fetch(`${base}/api/watch/0x${"b".repeat(64)}?since=${since}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      secondsPending: number;
      recommendation: string;
    };
    assert.ok(
      ["CONFIRMED", "FAILED", "NULL_PENDING", "DROPPED", "STUCK"].includes(body.status),
      `unexpected status ${body.status}`,
    );
    assert.ok(body.secondsPending >= 59, "secondsPending should derive from `since`");
    assert.ok(body.recommendation.length > 0, "every status must carry an actionable recommendation");
  });
});

describe("error handling", () => {
  it("answers an unknown /api path with JSON, not express's HTML", async () => {
    const res = await fetch(`${base}/api/definitely-not-a-route`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "NotFound");
  });

  it("answers a malformed JSON body with JSON, not an HTML stack trace", async () => {
    // express.json() rejects this upstream of every handler, so the route's own
    // try/catch never sees it. Without error middleware express replied with
    // HTML and the frontend's res.json() threw a parse error instead of
    // surfacing anything useful.
    const res = await fetch(`${base}/api/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "ValidationError");
  });

  it("400s on odd-length hex calldata instead of 500ing inside viem", async () => {
    const res = await fetch(`${base}/api/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tx: {
          from: `0x${"1".repeat(40)}`,
          to: `0x${"2".repeat(40)}`,
          data: "0x123", // not whole bytes
          value: "0",
          nonce: 0,
        },
      }),
    });
    assert.equal(res.status, 400);
  });
});

describe("watchlist consistency", () => {
  const address = `0x${"7".repeat(40)}`;

  it("404s when deleting something that was never watched", async () => {
    // POST already 409s for the equivalent no-op; DELETE used to return
    // 200 {removed:false} and pretend it had done something.
    const res = await fetch(`${base}/api/watchlist/${address}`, { method: "DELETE" });
    assert.equal(res.status, 404);
  });

  it("deletes a watched contract and reports it removed", async () => {
    const added = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    assert.equal(added.status, 201);

    const res = await fetch(`${base}/api/watchlist/${address}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { removed: boolean };
    assert.equal(body.removed, true);
  });
});
