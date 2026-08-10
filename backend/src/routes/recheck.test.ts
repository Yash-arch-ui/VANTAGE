// HTTP-level tests for POST /api/recheck — the live stale-state re-verification.
//
// The route is exercised against a MINIMAL in-test JSON-RPC stub (no real
// chain), so the two properties the stale-state flow depends on are pinned
// deterministically:
//
//   1. Drift is measured against the ORIGINAL quote stored on the ledger
//      entry, not a freshly re-quoted price. The stub's swap output is fixed
//      at 92% of the original quote — so the forecast can only report -8% /
//      STALE_STATE if the route hands the stored quote into the pipeline. If
//      a recheck ever re-baselined against a fresh quote, the "drift" would be
//      0 and this test would fail.
//
//   2. A recheck never creates a duplicate ledger entry: it is a re-read of
//      state, not a new audit event.
//
// The ledger, forecast pipeline and policy are the REAL implementations — only
// the chain itself is stubbed, via RPC_URL pointing at a local HTTP server
// that answers eth_* calls with canned values.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Express } from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The original quote the user was shown at evaluation time: 1 token. */
const ORIGINAL_QUOTE = 1_000_000_000_000_000_000n;
/** The pool has moved: the same transaction now yields 8% less than the quote. */
const SIMULATED_OUTPUT = (ORIGINAL_QUOTE * 92n) / 100n;

const FROM = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`;
const TO = "0x0000000000000000000000000000000000000002" as `0x${string}`;
const DATA = "0xdeadbeef" as `0x${string}`;

// ── Minimal JSON-RPC stub ─────────────────────────────────────────────

type RpcLog = { method: string; params: unknown[] };
const rpcLog: RpcLog[] = [];

/**
 * What the stubbed pool currently returns for the transaction. Starts moved
 * (92% of the original quote) so the first recheck reports negative drift;
 * the "verdict updates" test flips it back to the quote to prove the SAME
 * entry's live verdict transitions WARN → PROCEED.
 */
let poolOutput: bigint = SIMULATED_OUTPUT;

function rpcResult(
  method: string,
  _params: unknown[],
): { result?: unknown; error?: { code: number; message: string } } {
  switch (method) {
    case "eth_getTransactionCount":
      return { result: "0x5" }; // the account's pending nonce
    case "eth_getBalance":
      return { result: "0x" + (10n ** 24n).toString(16) }; // plenty of MON
    case "eth_gasPrice":
      return { result: "0x3b9aca00" }; // 1 gwei
    case "eth_estimateGas":
      return { result: "0x5208" }; // 21,000
    case "eth_call":
      // The swap's current output — the pool's live state at recheck time.
      return { result: "0x" + poolOutput.toString(16).padStart(64, "0") };
    case "eth_blockNumber":
      return { result: "0x1" };
    case "eth_getBlockByNumber":
      return {
        result: {
          number: "0x1",
          timestamp: "0x64",
          hash: "0x" + "ab".repeat(32),
          parentHash: "0x" + "cd".repeat(32),
        },
      };
    case "eth_getLogs":
      return { result: [] }; // no recent activity → contentionScore 0
    default:
      return { error: { code: -32601, message: `method ${method} not implemented` } };
  }
}

function startFakeRpc(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
        rpcLog.push({ method: parsed.method, params: parsed.params ?? [] });
        const out = rpcResult(parsed.method, parsed.params ?? []);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, ...out }));
      } catch {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "bad request" }));
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") throw new Error("no port bound");
      resolve({ port: addr.port, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

// ── Harness ───────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "vantage-recheck-"));

let fakeRpc: { port: number; close: () => Promise<void> };
let server: Server;
let base: string;
let entryId: string;

before(async () => {
  // Start the stub chain first, then point the backend at it — RPC_URL is
  // read by config.ts at module load, so it must be set before the import.
  fakeRpc = await startFakeRpc();
  process.env.RPC_URL = `http://127.0.0.1:${fakeRpc.port}`;
  process.env.DATABASE_PATH = join(tmpDir, "recheck.db");
  process.env.VANTAGE_NO_LISTEN = "1";

  const { app } = (await import("../server.js")) as { app: Express };
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port bound");
  base = `http://127.0.0.1:${addr.port}`;

  // Seed exactly the way /api/evaluate would: the full forecast — including
  // the ORIGINAL quotedOutput — is persisted into forecast_json.
  const { recordEntry } = await import("../em/ledger.js");
  entryId = recordEntry({
    txFrom: FROM,
    txTo: TO,
    txData: DATA,
    txValue: "0",
    forecast: {
      simulationSuccess: false,
      revertReason: null,
      simulatedOutput: null,
      quotedOutput: ORIGINAL_QUOTE.toString(),
      outputDriftPercent: null,
      gasEstimate: null,
      balanceSufficient: null,
      nonceCurrent: null,
      nonceIssue: null,
      contentionScore: null,
      riskLevel: "LOW",
      flags: [],
      timestamp: Date.now(),
    },
    policy: { action: "PROCEED", reason: "seed" },
    explanation: "seed",
  })!;
  assert.ok(entryId, "seeding must succeed");
});

after(async () => {
  // Guarded: if `before` failed partway, these may never have been assigned.
  if (fakeRpc) await fakeRpc.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("POST /api/recheck — stale-state re-verification", () => {
  it("preserves the ORIGINAL quote on the ledger entry", async () => {
    const { getEntryById } = await import("../em/ledger.js");
    const saved = JSON.parse(getEntryById(entryId)!.forecast_json) as {
      quotedOutput?: string | null;
    };
    assert.equal(saved.quotedOutput, ORIGINAL_QUOTE.toString());
  });

  it("measures drift against the ORIGINAL stored quote, not a refreshed one", async () => {
    rpcLog.length = 0;
    const res = await fetch(`${base}/api/recheck`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId }),
    });
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      entryId: string;
      forecast: {
        outputDriftPercent: number | null;
        flags: string[];
        riskLevel: string;
        simulatedOutput: string | null;
      };
      policy: { action: string; reason: string };
    };

    // The stub pool returns 92% of the ORIGINAL quote. If the recheck had
    // re-baselined against a fresh quote (the anti-pattern this test guards
    // against), drift would read 0 and STALE_STATE would never fire.
    assert.equal(body.entryId, entryId);
    assert.equal(body.forecast.simulatedOutput, SIMULATED_OUTPUT.toString());
    assert.equal(body.forecast.outputDriftPercent, -8);
    assert.ok(body.forecast.flags.includes("STALE_STATE"));
    assert.equal(body.forecast.riskLevel, "HIGH");
    assert.equal(body.policy.action, "WARN");
    assert.ok(body.policy.reason.includes("drift"));

    // The pipeline really re-simulated against the chain: eth_call fired with
    // the evaluated transaction's calldata.
    const call = rpcLog.find((r) => r.method === "eth_call");
    assert.ok(call, "recheck must re-run the simulation against fresh state");
    const params = call!.params[0] as { data?: string };
    assert.equal(params.data, DATA);
  });

  it("updates the SAME entry's live verdict when the pool returns to the quote", async () => {
    // The pool recovers to exactly the price the user was quoted. The same
    // entry re-checked now reads drift 0 → STALE_STATE clears → PROCEED,
    // proving the live verdict updates in both directions.
    poolOutput = ORIGINAL_QUOTE;
    try {
      const res = await fetch(`${base}/api/recheck`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        forecast: { outputDriftPercent: number | null; flags: string[]; riskLevel: string };
        policy: { action: string };
      };
      assert.equal(body.forecast.outputDriftPercent, 0);
      assert.ok(!body.forecast.flags.includes("STALE_STATE"));
      assert.equal(body.forecast.riskLevel, "LOW");
      assert.equal(body.policy.action, "PROCEED");
    } finally {
      // Leave the stub in the drifted state for the remaining tests.
      poolOutput = SIMULATED_OUTPUT;
    }
  });

  it("never creates a duplicate ledger entry", async () => {
    const { getRecentEntries } = await import("../em/ledger.js");
    const beforeCount = getRecentEntries().total;
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/api/recheck`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId }),
      });
      assert.equal(res.status, 200);
    }
    assert.equal(
      getRecentEntries().total,
      beforeCount,
      "a recheck must never write a new ledger row",
    );
  });

  it("404s for an unknown entryId", async () => {
    const res = await fetch(`${base}/api/recheck`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "00000000-0000-4000-8000-000000000000" }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "NotFound");
  });
});
