// Forecast-level tests for user-registered contract ABIs.
//
// The chain is the same minimal in-test JSON-RPC stub used by
// routes/evaluate.test.ts and psg/conflict-rpc.test.ts: the ledger, the ABI
// resolution and the decode pipeline are the REAL implementations; only the
// chain is stubbed. This pins the three behaviors that must hold:
//
//   1. Precedence: KNOWN_CONTRACTS (the demo deployments) always win over a
//      user registration for the same address — their behavior must never
//      change because a user registered a different ABI.
//   2. Rich decode: a registered address gets the same simulateContract +
//      decode path as the demo contracts, with contractSource
//      "user-registered" — including decoding a custom revert against the
//      user ABI's own error definitions (not the hardcoded selector set).
//   3. Safety: a malformed stored ABI (bypassing the route, written straight
//      to the DB) degrades to the generic path — never a crash, never a
//      wrong-source claim.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, toFunctionSelector } from "viem";

const tmpDir = mkdtempSync(join(tmpdir(), "vantage-userabi-"));

// ── The user contract fixture ────────────────────────────────────────────

const USER_ADDRESS = "0x8888888888888888888888888888888888888888" as `0x${string}`;
const EVAL_FROM = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as `0x${string}`;

/** Human-readable ABI as a user would paste it (the wire format). */
const USER_ABI_JSON = JSON.stringify([
  { type: "error", name: "VestingLocked", inputs: [{ type: "uint256", name: "until" }] },
  {
    type: "function",
    name: "vestedAmount",
    stateMutability: "view",
    inputs: [{ type: "address", name: "who" }],
    outputs: [{ type: "uint256", name: "amount" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ type: "uint256", name: "paid" }],
  },
]);

const VESTED_DATA = encodeFunctionData({
  abi: [
    {
      type: "function",
      name: "vestedAmount",
      stateMutability: "view",
      inputs: [{ type: "address", name: "who" }],
      outputs: [{ type: "uint256", name: "amount" }],
    },
  ],
  functionName: "vestedAmount",
  args: [EVAL_FROM],
});

const CLAIM_DATA = encodeFunctionData({
  abi: [
    {
      type: "function",
      name: "claim",
      stateMutability: "nonpayable",
      inputs: [],
      outputs: [{ type: "uint256", name: "paid" }],
    },
  ],
  functionName: "claim",
  args: [],
});

// Selector for the user ABI's custom error — used to make the stub revert
// with exactly the bytes a real VestingLocked(1234567890) revert emits.
const SEL_VESTING_LOCKED = toFunctionSelector("VestingLocked(uint256)");
const VESTING_REVERT_DATA =
  ("0x" + SEL_VESTING_LOCKED.slice(2) +
   BigInt(1_234_567_890).toString(16).padStart(64, "0")) as `0x${string}`;

// ── Stub chain ───────────────────────────────────────────────────────────

let callResult: {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
} = { result: "0x" };

function rpcResult(
  method: string,
): { result?: unknown; error?: { code: number; message: string; data?: unknown } } {
  switch (method) {
    case "eth_getTransactionCount":
      return { result: "0x5" };
    case "eth_getBalance":
      return { result: "0x" + (10n ** 24n).toString(16) };
    case "eth_gasPrice":
      return { result: "0x3b9aca00" };
    case "eth_estimateGas":
      return { result: "0x5208" };
    case "eth_call":
      return callResult;
    case "eth_blockNumber":
      return { result: "0x1" };
    case "eth_getBlockByNumber":
      return {
        result: {
          number: "0x1",
          timestamp: "0x64",
          hash: "0x" + "ab".repeat(32),
          parentHash: "0x" + "cd".repeat(32),
          transactions: [],
        },
      };
    case "eth_getLogs":
      return { result: [] };
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
        const parsed = JSON.parse(body) as { id: number; method: string };
        const out = rpcResult(parsed.method);
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

// ── Harness ───────────────────────────────────────────────────────────────

let fakeRpc: { port: number; close: () => Promise<void> };

before(async () => {
  fakeRpc = await startFakeRpc();
  process.env.RPC_URL = `http://127.0.0.1:${fakeRpc.port}`;
  process.env.DATABASE_PATH = join(tmpDir, "userabi.db");
  process.env.VANTAGE_NO_LISTEN = "1";

  // Import order matters: config.ts reads RPC_URL at module load, and the
  // ledger must exist before anything resolves user contracts.
  const { initDatabase, upsertUserContract } = await import("../em/ledger.js");
  initDatabase(join(tmpDir, "userabi.db"));
  upsertUserContract(USER_ADDRESS, USER_ABI_JSON, "Test Vesting");

  await import("../psg/forecast.js");
});

after(async () => {
  if (fakeRpc) await fakeRpc.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("getForecast — user-registered contract ABI resolution", () => {
  it("decodes a user-registered view call with contractSource 'user-registered'", async () => {
    const { getForecast } = await import("../psg/forecast.js");
    callResult = { result: "0x" + (123_456n).toString(16).padStart(64, "0") };

    const forecast = await getForecast(
      {
        from: EVAL_FROM,
        to: USER_ADDRESS,
        data: VESTED_DATA,
        value: 0n,
        nonce: 5,
      },
      100_000n, // quoted → drift is computable too
    );

    assert.equal(forecast.simulationSuccess, true);
    assert.equal(forecast.contractSource, "user-registered");
    assert.equal(forecast.simulatedOutput, "123456");
    // (123456 - 100000) * 10000 / 100000 = 2345 (bigint-truncated) → 23.45%
    assert.ok(forecast.outputDriftPercent !== null);
    assert.ok(Math.abs(forecast.outputDriftPercent - 23.45) < 0.001);
    assert.equal(forecast.gasEstimate, "21000");
  });

  it("decodes a custom revert against the user ABI's own error definitions", async () => {
    const { getForecast } = await import("../psg/forecast.js");
    // eth_call reverting with the user ABI's VestingLocked(uint256) selector.
    callResult = {
      error: { code: 3, message: "execution reverted", data: VESTING_REVERT_DATA },
    };

    const forecast = await getForecast({
      from: EVAL_FROM,
      to: USER_ADDRESS,
      data: CLAIM_DATA,
      value: 0n,
      nonce: 5,
    });

    assert.equal(forecast.simulationSuccess, false);
    // THE point of the user-ABI path: the custom error decodes with its real
    // name and arg, not "Unknown error selector: 0x…".
    assert.equal(forecast.revertReason, "VestingLocked(1234567890)");
    // The revert forecast must still report the truthful source — the decode
    // came from the user's ABI, and base()'s "generic" default must not paper
    // over it on the failure path.
    assert.equal(forecast.contractSource, "user-registered");
  });

  it("keeps KNOWN_CONTRACTS precedence — a user registration for the demo AMM is ignored", async () => {
    const { getForecast, AMM_ADDRESS } = await import("../psg/forecast.js");
    const { upsertUserContract } = await import("../em/ledger.js");
    assert.ok(AMM_ADDRESS, "deployments.json must supply the AMM");

    // A hostile/naive user registers a DIFFERENT ABI for the demo AMM address.
    // The registered ABI has no swap function, so if the user registration
    // ever won, the swap below would fail to decode.
    upsertUserContract(AMM_ADDRESS, USER_ABI_JSON, "hostile takeover");

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
      args: [0n, true, 1n],
    });
    callResult = { result: "0x" + (1_000_000n).toString(16).padStart(64, "0") };

    const forecast = await getForecast(
      { from: EVAL_FROM, to: AMM_ADDRESS as `0x${string}`, data: SWAP_DATA, value: 0n, nonce: 5 },
      undefined,
    );

    // The demo contract keeps its own path — contractSource is "known", and
    // the swap-specific drift logic (getExpectedOutput re-quote) ran, which
    // only exists on the known path. The stub returns 1e6 for every eth_call,
    // so simulatedOutput reflects the getExpectedOutput re-quote.
    assert.equal(forecast.contractSource, "known");
    assert.equal(forecast.simulationSuccess, true);
    assert.equal(forecast.simulatedOutput, "1000000");
  });

  it("degrades to the generic path when the stored ABI is malformed", async () => {
    const { getForecast } = await import("../psg/forecast.js");
    const { upsertUserContract } = await import("../em/ledger.js");

    // Bypass the route's validation entirely — corrupt the row straight in
    // the DB. resolveUserContract must treat it as "not registered".
    const BAD_ADDRESS = "0x7777777777777777777777777777777777777777" as `0x${string}`;
    upsertUserContract(BAD_ADDRESS, "{not even json", "corrupt");
    // And an ABI that is valid JSON but viem cannot parse (duplicate/broken
    // shapes) — written raw, again bypassing the route.
    const UNPARSEABLE = "0x6666666666666666666666666666666666666666" as `0x${string}`;
    upsertUserContract(UNPARSEABLE, JSON.stringify(["function this is not valid("]), "unparseable");

    callResult = { result: "0x" + (42n).toString(16).padStart(64, "0") };

    for (const addr of [BAD_ADDRESS, UNPARSEABLE]) {
      const forecast = await getForecast({
        from: EVAL_FROM,
        to: addr,
        data: CLAIM_DATA,
        value: 0n,
        nonce: 5,
      });
      // No crash, and honest about what happened: generic fallback, never a
      // "user-registered" claim on an ABI we could not parse.
      assert.equal(forecast.contractSource, "generic");
    }
  });

  it("an unregistered address still takes the generic path (regression)", async () => {
    const { getForecast } = await import("../psg/forecast.js");
    callResult = { result: "0x" + (7n).toString(16).padStart(64, "0") };

    const forecast = await getForecast(
      {
        from: EVAL_FROM,
        to: "0x9999999999999999999999999999999999999999" as `0x${string}`,
        data: CLAIM_DATA,
        value: 0n,
        nonce: 5,
      },
      7n,
    );

    assert.equal(forecast.contractSource, "generic");
    assert.equal(forecast.simulatedOutput, "7"); // first-word decode
    assert.equal(forecast.outputDriftPercent, 0);
  });
});
