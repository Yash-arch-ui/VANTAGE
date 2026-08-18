// HTTP-level regression tests for POST /api/evaluate — the execution-conflict
// snapshot bug and the behaviors that must not regress around it.
//
// The chain is a MINIMAL in-test JSON-RPC stub (no real network), following
// the exact pattern of routes/recheck.test.ts and psg/conflict-rpc.test.ts:
// the ledger, forecast pipeline and policy engine are REAL implementations,
// only the chain is stubbed. env vars are set BEFORE the dynamic import of
// server.ts (RPC_URL is read by config.ts at module load).
//
// The bug under test: when the initial decision is HOLD_AND_RECHECK, the route
// used to overwrite the response forecast with the hold loop's LAST scan
// (`if (held.forecast) forecast = held.forecast`). During a mempool flood the
// initial scan is HIGH_STATE_CONFLICT, the pool drains while the hold loop
// polls, and the final scan is clean — so the response advertised a clean
// forecast next to the hold's final policy, erasing the very evidence that
// triggered the hold. The fix keeps the ORIGINAL evaluation snapshot as the
// response forecast and returns the hold loop's final policy separately; the
// /api/recheck loop refreshes the live state afterwards.
//
// The hold loop's 3s/30s production cadence is overridden per-test via
// VANTAGE_HOLD_INTERVAL_MS / VANTAGE_HOLD_TIMEOUT_MS (read by the route at
// request time, defaults unchanged), so the resolve/timeout branches run in
// milliseconds instead of minutes.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Express } from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData } from "viem";

const SWAP_DATA = encodeFunctionData({
  abi: [
    {
      type: "function",
      name: "swap",
      stateMutability: "payable",
      inputs: [
        { type: "uint256", name: "minOutput" },
        { type: "bool", name: "inputIsToken" },
        { type: "uint256", name: "inputAmount" },
      ],
      outputs: [],
    },
  ],
  functionName: "swap",
  args: [0n, true, 1_000_000_000_000_000_000n],
});

const EVAL_FROM = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`;
const OTHER_FROM = "0x2222222222222222222222222222222222222222" as `0x${string}`;

// ── Stub state (driven per test) ──────────────────────────────────────

/** RPC-shaped pending transactions returned by the stub's pending block. */
let pendingTxs: unknown[] = [];
/**
 * When set, the pending block drains to empty after this many pending-block
 * scans — lets a test watch the mempool clear mid-hold (flooded scan 1-2 →
 * clean scan 3+). Null keeps the stub flooded forever.
 */
let drainAfterPendingScans: number | null = null;
let pendingScanCount = 0;
/** What eth_call returns — the pool's live output for the simulated swap. */
let poolOutput = 1_000_000_000_000_000_000n;
/** What eth_getTransactionCount returns — the account's pending nonce. */
let pendingNonce = "0x5"; // matches EVAL_FROM's tx nonce 5 → CURRENT

function rpcTx(
  to: string,
  input: string,
  from: string = OTHER_FROM,
  nonce = 1,
  gasPrice: string = "0x3b9aca00",
): unknown {
  return {
    type: "0x0",
    chainId: "0x27db",
    nonce: "0x" + nonce.toString(16),
    gasPrice,
    gas: "0x5208",
    to,
    value: "0x0",
    input,
    r: "0x1",
    s: "0x1",
    v: "0x1",
    hash: "0x" + String(nonce).padStart(64, "0"),
    blockHash: null,
    blockNumber: null,
    transactionIndex: null,
    from,
  };
}

/** Three viable competing swaps from OTHER_FROM — drives conflictScore ≥ 0.6. */
function floodTxs(amm: string): unknown[] {
  return [
    rpcTx(amm, SWAP_DATA, OTHER_FROM, 1),
    rpcTx(amm, SWAP_DATA, OTHER_FROM, 2),
    rpcTx(amm, SWAP_DATA, OTHER_FROM, 3),
  ];
}

function rpcResult(
  method: string,
  params: unknown[],
): { result?: unknown; error?: { code: number; message: string } } {
  switch (method) {
    case "eth_getTransactionCount":
      return { result: pendingNonce };
    case "eth_getBalance":
      return { result: "0x" + (10n ** 24n).toString(16) }; // plenty of MON
    case "eth_gasPrice":
      return { result: "0x3b9aca00" }; // 1 gwei
    case "eth_estimateGas":
      return { result: "0x5208" }; // 21,000
    case "eth_call":
      return { result: "0x" + poolOutput.toString(16).padStart(64, "0") };
    case "eth_blockNumber":
      return { result: "0x1" };
    case "eth_getBlockByNumber": {
      if (params[0] === "pending") {
        pendingScanCount++;
        const drained =
          drainAfterPendingScans !== null && pendingScanCount > drainAfterPendingScans;
        return {
          result: {
            number: "0x1",
            timestamp: "0x64",
            hash: "0x" + "ab".repeat(32),
            parentHash: "0x" + "cd".repeat(32),
            transactions: drained ? [] : pendingTxs,
          },
        };
      }
      return {
        result: {
          number: "0x1",
          timestamp: "0x64",
          hash: "0x" + "ab".repeat(32),
          parentHash: "0x" + "cd".repeat(32),
        },
      };
    }
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

const tmpDir = mkdtempSync(join(tmpdir(), "vantage-evaluate-"));

let fakeRpc: { port: number; close: () => Promise<void> };
let server: Server;
let base: string;
let AMM_ADDRESS: string;

before(async () => {
  // Start the stub chain first, then point the backend at it — RPC_URL is
  // read by config.ts at module load, so it must be set before the import.
  fakeRpc = await startFakeRpc();
  process.env.RPC_URL = `http://127.0.0.1:${fakeRpc.port}`;
  process.env.DATABASE_PATH = join(tmpDir, "evaluate.db");
  process.env.GEMINI_API_KEY = "";
  process.env.VANTAGE_NO_LISTEN = "1";

  const { app } = (await import("../server.js")) as { app: Express };
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port bound");
  base = `http://127.0.0.1:${addr.port}`;

  const forecast = (await import("../psg/forecast.js")) as { AMM_ADDRESS: string };
  AMM_ADDRESS = forecast.AMM_ADDRESS;
  assert.ok(/^0x[a-fA-F0-9]{40}$/.test(AMM_ADDRESS), "deployments.json must supply the AMM");
});

after(async () => {
  if (fakeRpc) await fakeRpc.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Helpers ───────────────────────────────────────────────────────────

function resetStub() {
  pendingTxs = [];
  drainAfterPendingScans = null;
  pendingScanCount = 0;
  poolOutput = 1_000_000_000_000_000_000n;
  pendingNonce = "0x5";
  // Production defaults (3s / 30s) unless a test overrides them.
  delete process.env.VANTAGE_HOLD_INTERVAL_MS;
  delete process.env.VANTAGE_HOLD_TIMEOUT_MS;
}

async function postEvaluate(body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as EvaluateBody };
}

type EvaluateBody = {
  forecast: {
    conflictScore?: number | null;
    conflictFlags?: string[];
    conflictEvidence?: {
      source: string;
      competingTxCount: number;
      competingSwapCount: number;
      competingPoolWriterCount: number;
      competingClaimCount: number;
      pendingPoolSize: number;
      relevantTxs: unknown[];
    } | null;
    flags: string[];
    riskLevel: string;
    outputDriftPercent: number | null;
    contentionScore: number | null;
    nonceIssue: string | null;
  };
  policy: { action: string; reason: string };
  explanation: string;
  entryId: string | null;
};

function evalRequest(overrides: Record<string, unknown> = {}) {
  return {
    tx: {
      from: EVAL_FROM,
      to: AMM_ADDRESS,
      data: SWAP_DATA,
      value: "0",
      nonce: 5,
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("POST /api/evaluate — execution-conflict snapshot preservation", () => {
  it("A: initial HIGH conflict → /api/evaluate returns the HIGH conflict evidence", async () => {
    resetStub();
    pendingTxs = floodTxs(AMM_ADDRESS);
    // Pool stays flooded → the hold loop runs to its timeout. A short timeout
    // keeps the request fast while still exercising the real hold path.
    process.env.VANTAGE_HOLD_TIMEOUT_MS = "300";

    const { status, body } = await postEvaluate(evalRequest());
    assert.equal(status, 200);

    // The forecast that triggered the hold — the evidence must be in the
    // response regardless of what the hold loop concluded.
    assert.ok(
      (body.forecast.conflictScore ?? 0) >= 0.6,
      `conflictScore ${body.forecast.conflictScore}`,
    );
    assert.deepEqual(body.forecast.conflictFlags, ["HIGH_STATE_CONFLICT"]);
    assert.ok(body.forecast.flags.includes("HIGH_STATE_CONFLICT"));
    assert.equal(body.forecast.conflictEvidence?.source, "pending-block");
    assert.equal(body.forecast.conflictEvidence?.competingSwapCount, 3);
    assert.equal(body.forecast.conflictEvidence?.competingTxCount, 3);
    assert.equal(body.forecast.riskLevel, "HIGH");
  });

  it("B: hold loop clears mid-flight → the INITIAL HIGH conflict forecast is preserved, final policy is the hold loop's", async () => {
    resetStub();
    pendingTxs = floodTxs(AMM_ADDRESS);
    // Initial scan (1) + hold re-scan (2) see the flood; scan 3+ is clean.
    drainAfterPendingScans = 2;
    process.env.VANTAGE_HOLD_INTERVAL_MS = "50";
    process.env.VANTAGE_HOLD_TIMEOUT_MS = "2000";

    const { status, body } = await postEvaluate(evalRequest());
    assert.equal(status, 200);

    // THE regression: the response must still carry the ORIGINAL HIGH
    // conflict snapshot, not the hold loop's final (clean) scan. Before the
    // fix this returned conflictScore 0 / no flags / 0 competing swaps.
    assert.ok(
      (body.forecast.conflictScore ?? 0) >= 0.6,
      `conflictScore ${body.forecast.conflictScore}`,
    );
    assert.deepEqual(body.forecast.conflictFlags, ["HIGH_STATE_CONFLICT"]);
    assert.ok(body.forecast.flags.includes("HIGH_STATE_CONFLICT"));
    assert.equal(body.forecast.conflictEvidence?.competingSwapCount, 3);
    assert.equal(body.forecast.conflictEvidence?.competingTxCount, 3);
    assert.equal(body.forecast.riskLevel, "HIGH");

    // …while the policy is the hold loop's final decision (the flood drained).
    assert.equal(body.policy.action, "PROCEED");
  });

  it("C: /api/recheck after the initial response returns a FRESH conflict scan", async () => {
    resetStub();
    pendingTxs = floodTxs(AMM_ADDRESS);
    process.env.VANTAGE_HOLD_TIMEOUT_MS = "300";

    const { body: evaluateBody } = await postEvaluate(evalRequest());
    assert.ok(evaluateBody.entryId, "evaluate must persist an entry for the recheck");
    assert.equal(evaluateBody.forecast.conflictEvidence?.competingSwapCount, 3);

    // The mempool drains after the initial response; the recheck re-scans and
    // must report the FRESH state (score, flags and evidence from one scan).
    pendingTxs = [];
    drainAfterPendingScans = null;
    pendingScanCount = 0;

    const res = await fetch(`${base}/api/recheck`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: evaluateBody.entryId }),
    });
    assert.equal(res.status, 200);
    const recheck = (await res.json()) as {
      recheckedAt: number;
      forecast: {
        conflictScore: number | null;
        conflictFlags: string[];
        conflictEvidence: { source: string; competingSwapCount: number } | null;
      };
    };
    assert.ok(recheck.recheckedAt > 0);
    assert.equal(recheck.forecast.conflictScore, 0);
    assert.deepEqual(recheck.forecast.conflictFlags, []);
    assert.equal(recheck.forecast.conflictEvidence?.source, "pending-block");
    assert.equal(recheck.forecast.conflictEvidence?.competingSwapCount, 0);
  });

  it("E: HIGH conflict + hold timeout → SUGGEST_ADJUSTMENT policy with the initial conflict evidence still visible", async () => {
    resetStub();
    pendingTxs = floodTxs(AMM_ADDRESS); // never drains
    process.env.VANTAGE_HOLD_TIMEOUT_MS = "300";

    const { status, body } = await postEvaluate(evalRequest());
    assert.equal(status, 200);

    assert.equal(body.policy.action, "SUGGEST_ADJUSTMENT");
    // The hold loop timed out — but the initial evidence must not be erased.
    assert.ok((body.forecast.conflictScore ?? 0) >= 0.6);
    assert.deepEqual(body.forecast.conflictFlags, ["HIGH_STATE_CONFLICT"]);
    assert.equal(body.forecast.conflictEvidence?.competingSwapCount, 3);
  });

  it("F: clean transaction → unchanged PROCEED behavior", async () => {
    resetStub(); // empty mempool, pool output == quote → drift 0

    const { status, body } = await postEvaluate(
      evalRequest({ quotedOutput: "1000000000000000000" }),
    );
    assert.equal(status, 200);
    assert.equal(body.policy.action, "PROCEED");
    assert.equal(body.forecast.conflictScore, 0);
    assert.deepEqual(body.forecast.conflictFlags, []);
    assert.equal(body.forecast.conflictEvidence?.competingSwapCount, 0);
    assert.equal(body.forecast.outputDriftPercent, 0);
    assert.equal(body.forecast.riskLevel, "LOW");
  });

  it("G: nonce ABORT precedence is unchanged — a nonce gap is never downgraded to HOLD", async () => {
    resetStub();
    pendingTxs = floodTxs(AMM_ADDRESS); // HIGH conflict is ALSO present
    pendingNonce = "0x2"; // tx nonce 5 > pending 2 → NONCE_GAP

    const { status, body } = await postEvaluate(evalRequest());
    assert.equal(status, 200);
    // ABORT, not HOLD_AND_RECHECK — the nonce can never be fixed by holding.
    assert.equal(body.policy.action, "ABORT");
    assert.ok(body.forecast.flags.includes("NONCE_GAP"));
    assert.equal(body.forecast.nonceIssue, "GAP");
    assert.ok(body.policy.reason.includes("nonce gap"));
    // The conflict evidence still rides the response unchanged.
    assert.ok((body.forecast.conflictScore ?? 0) >= 0.6);
  });

  it("H: existing drift behavior is unchanged on the evaluate path", async () => {
    resetStub();
    // Pool moved to 92% of the quote → −8% drift → STALE_STATE → WARN.
    poolOutput = (1_000_000_000_000_000_000n * 92n) / 100n;

    const { status, body } = await postEvaluate(
      evalRequest({ quotedOutput: "1000000000000000000" }),
    );
    assert.equal(status, 200);
    assert.equal(body.forecast.outputDriftPercent, -8);
    assert.ok(body.forecast.flags.includes("STALE_STATE"));
    assert.equal(body.forecast.riskLevel, "HIGH");
    assert.equal(body.policy.action, "WARN");
  });
});
