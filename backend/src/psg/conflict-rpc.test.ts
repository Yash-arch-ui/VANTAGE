// ECA — RPC-mock integration tests.
//
// The chain is a MINIMAL in-test JSON-RPC stub (no real network). The stub's
// eth_getBlockByNumber("pending", true) answer is driven per-test, so the two
// behaviors the ECA depends on are pinned deterministically:
//
//   1. Mempool enumeration: pending-block transactions are read and counted
//      (competing swaps → HIGH_STATE_CONFLICT → HOLD_AND_RECHECK).
//   2. Automatic fallback: when the pending block is rejected, scanConflict
//      degrades to the log/calldata strategy (getContentionScore halved) and
//      never claims HIGH_STATE_CONFLICT without mempool evidence.
//
// The forecast pipeline, policy engine and ledger are the REAL implementations
// — only the chain itself is stubbed, via RPC_URL pointing at a local server
// that answers eth_* calls with canned values. env vars are set BEFORE the
// dynamic import of server/forecast modules, matching routes/recheck.test.ts.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
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
/** When true, the stub rejects eth_getBlockByNumber("pending", true). */
let rejectPendingBlock = false;
/** How many logs eth_getLogs returns — drives contention in the fallback. */
let logCount = 0;

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

function rpcResult(
  method: string,
  params: unknown[],
): { result?: unknown; error?: { code: number; message: string } } {
  switch (method) {
    case "eth_getTransactionCount":
      return { result: "0x5" }; // matches the eval tx nonce → CURRENT
    case "eth_getBalance":
      return { result: "0x" + (10n ** 24n).toString(16) }; // plenty of MON
    case "eth_gasPrice":
      return { result: "0x3b9aca00" }; // 1 gwei
    case "eth_estimateGas":
      return { result: "0x5208" }; // 21,000
    case "eth_call":
      // Any simulation returns 1 token. No quotedOutput is passed in these
      // tests, so drift stays null and never interferes.
      return { result: "0x" + (10n ** 18n).toString(16).padStart(64, "0") };
    case "eth_blockNumber":
      return { result: "0x1" };
    case "eth_getBlockByNumber": {
      if (params[0] === "pending") {
        if (rejectPendingBlock) {
          return { error: { code: -32601, message: "pending block not supported" } };
        }
        return {
          result: {
            number: "0x1",
            timestamp: "0x64",
            hash: "0x" + "ab".repeat(32),
            parentHash: "0x" + "cd".repeat(32),
            transactions: pendingTxs,
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
    case "eth_getLogs": {
      const logs: unknown[] = [];
      for (let i = 0; i < logCount; i++) {
        logs.push({
          address: "0x" + "11".repeat(20),
          topics: ["0x" + "aa".repeat(32)],
          data: "0x",
          blockNumber: "0x1",
          transactionHash: "0x" + "bb".repeat(32),
          transactionIndex: "0x0",
          blockHash: "0x" + "ab".repeat(32),
          logIndex: "0x" + i.toString(16),
          removed: false,
        });
      }
      return { result: logs };
    }
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

const tmpDir = mkdtempSync(join(tmpdir(), "vantage-eca-"));

let fakeRpc: { port: number; close: () => Promise<void> };

before(async () => {
  fakeRpc = await startFakeRpc();
  process.env.RPC_URL = `http://127.0.0.1:${fakeRpc.port}`;
  process.env.DATABASE_PATH = join(tmpDir, "eca.db");
  process.env.GEMINI_API_KEY = "";
  // The public client singleton is created at first getPublicClient() call
  // with the RPC_URL above — the modules below are imported AFTER the env is
  // set, exactly like routes/recheck.test.ts.
});

after(async () => {
  if (fakeRpc) await fakeRpc.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("ECA — scanConflict (pending-block enumeration)", () => {
  it("reads competing swaps from the pending block → HIGH_STATE_CONFLICT", async () => {
    const { scanConflict, AMM_ADDRESS } = await import("./forecast.js");
    pendingTxs = [
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 1),
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 2),
      rpcTx("0x" + "99".repeat(20), "0xdeadbeef", OTHER_FROM, 3),
      rpcTx("0x" + "99".repeat(20), "0xdeadbeef", OTHER_FROM, 4),
    ];
    try {
      const r = await scanConflict({
        from: EVAL_FROM,
        to: AMM_ADDRESS,
        data: SWAP_DATA,
        value: 0n,
        nonce: 5,
      });
      assert.equal(r.evidence.source, "pending-block");
      assert.equal(r.evidence.competingTxCount, 2);
      assert.equal(r.evidence.competingSwapCount, 2);
      assert.equal(r.evidence.pendingPoolSize, 4);
      assert.deepEqual(r.flags, ["HIGH_STATE_CONFLICT"]);
      // 2 swaps, pool of 4: direct g(2,1) → 0.57333 + same g(2,2) → 0.04
      // + pool g(4,250) → 0.00095 → 0.614
      assert.equal(r.conflictScore, 0.614);
    } finally {
      pendingTxs = [];
    }
  });

  it("zero-gasPrice pending swaps (Monad artifact) are filtered from the counts", async () => {
    const { scanConflict, AMM_ADDRESS } = await import("./forecast.js");
    pendingTxs = [
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 1, "0x0"), // cannot mine
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 2, "0x0"), // cannot mine
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 3), // viable
    ];
    try {
      const r = await scanConflict({
        from: EVAL_FROM,
        to: AMM_ADDRESS,
        data: SWAP_DATA,
        value: 0n,
        nonce: 5,
      });
      assert.equal(r.evidence.source, "pending-block");
      assert.equal(r.evidence.competingSwapCount, 1);
      assert.equal(r.evidence.excludedNonViableCount, 2);
      assert.equal(r.evidence.pendingPoolSize, 1);
      assert.equal(r.conflictScore, 0.457);
      assert.deepEqual(r.flags, ["POTENTIAL_STATE_CONFLICT"]);
    } finally {
      pendingTxs = [];
    }
  });

  it("a clean mempool → conflictScore 0 and no flags", async () => {
    const { scanConflict, AMM_ADDRESS } = await import("./forecast.js");
    pendingTxs = [];
    const r = await scanConflict({
      from: EVAL_FROM,
      to: AMM_ADDRESS,
      data: SWAP_DATA,
      value: 0n,
      nonce: 5,
    });
    assert.equal(r.evidence.source, "pending-block");
    assert.equal(r.conflictScore, 0);
    assert.deepEqual(r.flags, []);
  });
});

describe("ECA — scanConflict (logs-fallback when the mempool is unavailable)", () => {
  it("rejected pending block → logs-fallback, no flags, error recorded", async () => {
    const { scanConflict, AMM_ADDRESS } = await import("./forecast.js");
    rejectPendingBlock = true;
    logCount = 0;
    try {
      const r = await scanConflict({
        from: EVAL_FROM,
        to: AMM_ADDRESS,
        data: SWAP_DATA,
        value: 0n,
        nonce: 5,
      });
      assert.equal(r.evidence.source, "logs-fallback");
      assert.equal(r.evidence.competingTxCount, 0);
      assert.equal(r.conflictScore, 0);
      assert.deepEqual(r.flags, []);
      assert.ok(r.evidence.error, "fallback must record why the mempool was unavailable");
    } finally {
      rejectPendingBlock = false;
    }
  });

  it("fallback never claims HIGH_STATE_CONFLICT (score capped at contention×0.5)", async () => {
    const { scanConflict, AMM_ADDRESS } = await import("./forecast.js");
    rejectPendingBlock = true;
    logCount = 20; // contention 1.0 → fallback score 0.5 → POTENTIAL at most
    try {
      const r = await scanConflict({
        from: EVAL_FROM,
        to: AMM_ADDRESS,
        data: SWAP_DATA,
        value: 0n,
        nonce: 5,
      });
      assert.equal(r.evidence.source, "logs-fallback");
      assert.equal(r.conflictScore, 0.5);
      assert.deepEqual(r.flags, ["POTENTIAL_STATE_CONFLICT"]);
    } finally {
      rejectPendingBlock = false;
      logCount = 0;
    }
  });
});

describe("ECA — full pipeline (getPSGForecast → decidePolicy)", () => {
  it("competing swaps → HIGH_STATE_CONFLICT → risk HIGH → HOLD_AND_RECHECK", async () => {
    const { getPSGForecast, AMM_ADDRESS } = await import("./forecast.js");
    const { decidePolicy } = await import("../apa/policy.js");
    pendingTxs = [
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 1),
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 2),
    ];
    try {
      const forecast = await getPSGForecast({
        from: EVAL_FROM,
        to: AMM_ADDRESS,
        data: SWAP_DATA,
        value: 0n,
        nonce: 5,
      });
      // 2 competing swaps, pool of 2: direct g(2,1) → 0.57333 + same g(2,2)
      // → 0.04 + pool g(2,250) → 0.00048 → 0.614
      assert.equal(forecast.conflictScore, 0.614);
      assert.deepEqual(forecast.conflictFlags, ["HIGH_STATE_CONFLICT"]);
      assert.ok(forecast.flags.includes("HIGH_STATE_CONFLICT"));
      assert.equal(forecast.riskLevel, "HIGH");

      const policy = decidePolicy(forecast);
      assert.equal(policy.action, "HOLD_AND_RECHECK");
      assert.ok(policy.reason.toLowerCase().includes("conflict"));
    } finally {
      pendingTxs = [];
    }
  });

  it("competing swaps + high contention → HOLD_AND_RECHECK (conflict + contention)", async () => {
    const { getPSGForecast, AMM_ADDRESS } = await import("./forecast.js");
    const { decidePolicy } = await import("../apa/policy.js");
    pendingTxs = [
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 1),
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 2),
    ];
    logCount = 20; // contention 1.0 → HIGH_CONTENTION flag as well
    try {
      const forecast = await getPSGForecast({
        from: EVAL_FROM,
        to: AMM_ADDRESS,
        data: SWAP_DATA,
        value: 0n,
        nonce: 5,
      });
      assert.ok(forecast.flags.includes("HIGH_CONTENTION"));
      assert.ok(forecast.flags.includes("HIGH_STATE_CONFLICT"));
      assert.equal(forecast.riskLevel, "HIGH");
      assert.equal(decidePolicy(forecast).action, "HOLD_AND_RECHECK");
    } finally {
      pendingTxs = [];
      logCount = 0;
    }
  });

  it("clean mempool → LOW risk → PROCEED", async () => {
    const { getPSGForecast, AMM_ADDRESS } = await import("./forecast.js");
    const { decidePolicy } = await import("../apa/policy.js");
    pendingTxs = [];
    const forecast = await getPSGForecast({
      from: EVAL_FROM,
      to: AMM_ADDRESS,
      data: SWAP_DATA,
      value: 0n,
      nonce: 5,
    });
    assert.equal(forecast.conflictScore, 0);
    assert.deepEqual(forecast.conflictFlags, []);
    assert.equal(forecast.riskLevel, "LOW");
    assert.equal(decidePolicy(forecast).action, "PROCEED");
  });
});

describe("ECA — persistence into the audit ledger (forecast_json)", () => {
  it("conflictScore + conflictFlags + evidence are persisted on the audit row", async () => {
    const { getPSGForecast, AMM_ADDRESS } = await import("./forecast.js");
    const { recordEntry, getEntryById } = await import("../em/ledger.js");
    const { initDatabase } = await import("../em/ledger.js");
    initDatabase(process.env.DATABASE_PATH!);

    pendingTxs = [
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 1),
      rpcTx(AMM_ADDRESS, SWAP_DATA, OTHER_FROM, 2),
    ];
    try {
      const forecast = await getPSGForecast({
        from: EVAL_FROM,
        to: AMM_ADDRESS,
        data: SWAP_DATA,
        value: 0n,
        nonce: 5,
      });
      const entryId = recordEntry({
        txFrom: EVAL_FROM,
        txTo: AMM_ADDRESS,
        txData: SWAP_DATA,
        txValue: "0",
        forecast,
        policy: { action: "HOLD_AND_RECHECK", reason: "conflict" },
        explanation: "eca test",
      });
      assert.ok(entryId, "recordEntry must succeed");

      const saved = JSON.parse(getEntryById(entryId)!.forecast_json) as {
        conflictScore?: number | null;
        conflictFlags?: string[];
        conflictEvidence?: { source?: string; competingTxCount?: number; relevantTxs?: unknown[] };
      };
      assert.equal(saved.conflictScore, forecast.conflictScore);
      assert.deepEqual(saved.conflictFlags, ["HIGH_STATE_CONFLICT"]);
      assert.equal(saved.conflictEvidence?.source, "pending-block");
      assert.equal(saved.conflictEvidence?.competingTxCount, 2);
      assert.ok(Array.isArray(saved.conflictEvidence?.relevantTxs));
    } finally {
      pendingTxs = [];
    }
  });
});
