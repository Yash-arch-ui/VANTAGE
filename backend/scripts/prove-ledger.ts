// Live proof of Module III — Execution Memory — against the real backend on
// Monad testnet. Proves the immutable audit ledger end-to-end:
//
//   1. three real /api/evaluate calls persist three distinct audit rows
//      (PROCEED, ABORT via bad slippage, ABORT variant),
//   2. /api/outcome attaches CONFIRMED + a fake txHash to one of them and
//      recalibrates the per-contract hold threshold,
//   3. /api/stats reflects exactly those rows,
//   4. a raw SELECT on the SQLite file proves the rows are physically on disk,
//      not just in memory (ls -la shows the file and its size),
//   5. a SQL-injection sanity check proves hostile strings are stored inertly
//      through the parameterized inserts (the table survives).
//
// Run from the backend/ directory with the .env loaded:
//   set -a && . ../.env && set +a && ./node_modules/.bin/tsx scripts/prove-ledger.ts
//
// Uses a dedicated scratch DB (prove-ledger.db) so the real server DB
// (vantage.db) is never touched.

import { createPublicClient, http, encodeFunctionData, type Address } from "viem";
import { monadTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, rmSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import type { PSGForecast } from "../src/psg/forecast.js";
import type { PolicyResult } from "../src/apa/policy.js";
import { recordEntry } from "../src/em/ledger.js";
import { getThreshold } from "../src/em/calibrator.js";

const DB_PATH = "./prove-ledger.db";
const SWAP_INPUT_AMOUNT = 1n * 10n ** 17n; // 0.1 token per swap

// ── Env that MUST be set before any module reading process.env loads ───
// config.ts reads DATABASE_PATH via dotenv (which never overrides existing
// vars), so these are set here first. The src imports below are therefore
// dynamic — a static import would evaluate config.ts before these lines run.
process.env.DATABASE_PATH = DB_PATH;
process.env.VANTAGE_NO_LISTEN = "1";
process.env.GEMINI_API_KEY = ""; // force the deterministic template explainer

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type LedgerRow = {
  id: string;
  tx_to: string;
  policy_action: string;
  outcome: string | null;
  tx_hash: string | null;
  user_action: string | null;
  created_at: string;
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function main(): Promise<void> {
  // 0. Fresh scratch DB for a clean, reproducible run.
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(f)) rmSync(f);
  }

  const { config } = await import("../src/config.js");
  const { app } = await import("../src/server.js"); // runs initDatabase(prove-ledger.db)
  const { AMM_ADDRESS, ammAbi } = await import("../src/psg/forecast.js");

  const account = privateKeyToAccount(`0x${config.privateKey}`);
  const amm = AMM_ADDRESS as Address;
  const client = createPublicClient({ chain: monadTestnet, transport: http(config.rpcUrl) });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const api = (p: string) => `/api${p}`; // routers are mounted under /api

  console.log(`sender   = ${account.address}`);
  console.log(`AMM      = ${amm}`);
  console.log(`ledger   = ${DB_PATH} (scratch — real vantage.db untouched)`);
  console.log(`threshold before any outcome = ${getThreshold(amm)}`);

  // Real on-chain parameters for the simulate-only swaps.
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const expected = await client.readContract({
    address: amm,
    abi: ammAbi,
    functionName: "getExpectedOutput",
    args: [SWAP_INPUT_AMOUNT, true],
  });

  const buildTx = (minOutput: bigint) => ({
    from: account.address,
    to: amm,
    data: encodeFunctionData({
      abi: ammAbi,
      functionName: "swap",
      args: [minOutput, true, SWAP_INPUT_AMOUNT],
    }),
    value: "0",
    nonce,
  });

  // ── 1. Three /api/evaluate calls with different scenarios ─────────────
  console.log("\n=== 1. Persist three evaluations via /api/evaluate ===");

  console.log("\n  Scenario A — clean swap, minOutput=0 → expect PROCEED");
  const s1 = await post(api("/evaluate"), { tx: buildTx(0n) });
  const p1 = s1.body.policy as { action: string };
  const f1 = s1.body.forecast as { riskLevel: string; flags: string[]; contentionScore: number | null };
  console.log(`    HTTP ${s1.status} action=${p1.action} risk=${f1.riskLevel} flags=${JSON.stringify(f1.flags)} contention=${f1.contentionScore}`);
  assert(p1.action === "PROCEED", "scenario A resolves to PROCEED");
  assert(typeof s1.body.entryId === "string", "scenario A returned an entryId");
  const entryA = s1.body.entryId as string;

  console.log("\n  Scenario B — bad slippage, minOutput=10x → expect ABORT");
  const s2 = await post(api("/evaluate"), { tx: buildTx(expected * 10n) });
  const p2 = s2.body.policy as { action: string };
  const f2 = s2.body.forecast as { riskLevel: string; flags: string[] };
  console.log(`    HTTP ${s2.status} action=${p2.action} risk=${f2.riskLevel} flags=${JSON.stringify(f2.flags)}`);
  assert(p2.action === "ABORT", "scenario B resolves to ABORT");
  assert(typeof s2.body.entryId === "string", "scenario B returned an entryId");

  console.log("\n  Scenario C — second ABORT variant (minOutput=100x).");
  console.log("    A HOLD_AND_RECHECK path can't be forced right now: contention must be");
  console.log("    elevated over a 180s window of real AMM activity, which is not the");
  console.log("    case at proof time — so per the spec this falls back to an ABORT variant.");
  const s3 = await post(api("/evaluate"), { tx: buildTx(expected * 100n) });
  const p3 = s3.body.policy as { action: string };
  const f3 = s3.body.forecast as { riskLevel: string; flags: string[]; contentionScore: number | null };
  console.log(`    HTTP ${s3.status} action=${p3.action} risk=${f3.riskLevel} flags=${JSON.stringify(f3.flags)} contention=${f3.contentionScore}`);
  assert(typeof s3.body.entryId === "string", "scenario C returned an entryId");

  // ── 2. Report an outcome for one entry ────────────────────────────────
  console.log("\n=== 2. Report outcome via /api/outcome (CONFIRMED + fake txHash) ===");
  const fakeHash = `0x${"ab".repeat(32)}`;
  const out = await post(api("/outcome"), {
    entryId: entryA,
    userAction: "SIGNED",
    outcome: "CONFIRMED",
    txHash: fakeHash,
  });
  console.log(`    HTTP ${out.status} body=${JSON.stringify(out.body)}`);
  assert(out.status === 200 && out.body.ok === true, "outcome accepted");
  // Wait a beat for the outcome write + recalibration to settle, then read it back.
  await sleep(300);

  const thresholdAfter = getThreshold(amm);
  console.log(`  threshold after outcome (recalibrated) = ${thresholdAfter}`);
  assert(thresholdAfter < 0.7, "high failure rate lowered the calibrated hold threshold");

  // ── 3. /api/stats must reflect exactly the three entries ──────────────
  console.log("\n=== 3. GET /api/stats (should reflect exactly the 3 entries) ===");
  const statsRes = await fetch(`${base}/api/stats`);
  const stats = (await statsRes.json()) as {
    total: number;
    byAction: Record<string, number>;
    byOutcome: Record<string, number>;
    overridden: number;
  };
  console.log(`    ${JSON.stringify(stats, null, 2)}`);
  assert(stats.total === 3, `stats.total === 3 (got ${stats.total})`);
  assert(stats.byAction.PROCEED === 1 && stats.byAction.ABORT === 2, "byAction reflects {PROCEED:1, ABORT:2}");
  assert(stats.byOutcome.CONFIRMED === 1, "byOutcome reflects {CONFIRMED:1}");
  assert(stats.overridden === 0, "overridden === 0 (we reported SIGNED)");

  // ── 4. Raw SELECT on the SQLite file — rows physically on disk ────────
  console.log("\n=== 4. Raw SELECT on the .db file (proof of on-disk persistence) ===");
  const fileDb = new Database(DB_PATH);
  fileDb.pragma("wal_checkpoint(PASSIVE)"); // flush WAL so the main file carries the data

  const count = (fileDb.prepare("SELECT COUNT(*) AS c FROM execution_ledger").get() as { c: number }).c;
  const rows = fileDb.prepare(
    "SELECT id, tx_to, policy_action, outcome, tx_hash, user_action, created_at FROM execution_ledger ORDER BY created_at",
  ).all() as LedgerRow[];
  for (const row of rows) {
    console.log(`    ${row.id}  → ${row.policy_action}  outcome=${row.outcome ?? "-"}  user=${row.user_action ?? "-"}  hash=${row.tx_hash?.slice(0, 18) ?? "-"}…  at ${row.created_at}`);
  }
  assert(count === 3, `raw SELECT sees ${count} rows (expected 3)`);

  const thresholds = fileDb.prepare(
    "SELECT contract_address, hold_threshold, sample_count, last_calibrated FROM contention_thresholds",
  ).all();
  console.log(`  contention_thresholds rows: ${JSON.stringify(thresholds)}`);
  assert((thresholds as Array<{ hold_threshold: number }>)[0]?.hold_threshold === 0.63, "calibrated threshold persisted as 0.63");

  // ── 5. SQL-injection sanity check ─────────────────────────────────────
  console.log("\n=== 5. SQL-injection sanity check ===");
  const maliciousFrom = "'; DROP TABLE execution_ledger; --";
  const maliciousData = "0x' OR '1'='1; DROP TABLE contention_thresholds; --";
  const injectionForecast: PSGForecast = {
    simulationSuccess: false,
    revertReason: "injection sanity check — no real simulation",
    simulatedOutput: null,
    quotedOutput: null,
    outputDriftPercent: null,
    gasEstimate: null,
    balanceSufficient: null,
    nonceCurrent: null,
    nonceIssue: null,
    contentionScore: null,
    riskLevel: "CRITICAL",
    flags: ["REVERT"],
    timestamp: Date.now(),
  };
  const injectionPolicy: PolicyResult = { action: "ABORT", reason: "injection sanity check" };

  const injectionId = recordEntry({
    txFrom: maliciousFrom,
    txTo: amm,
    txData: maliciousData,
    txValue: "0",
    forecast: injectionForecast,
    policy: injectionPolicy,
    explanation: "SQL-injection sanity check — hostile string must be stored inertly",
  });
  assert(injectionId !== null, "recordEntry accepted the hostile payload as data");

  const tableStill = fileDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_ledger'")
    .get();
  const thresholdsStill = fileDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contention_thresholds'")
    .get();
  assert(tableStill !== undefined, "execution_ledger still exists after hostile insert");
  assert(thresholdsStill !== undefined, "contention_thresholds still exists after hostile insert");

  const stored = fileDb.prepare("SELECT tx_from, tx_data FROM execution_ledger WHERE id = ?").get(injectionId) as {
    tx_from: string;
    tx_data: string;
  };
  assert(stored.tx_from === maliciousFrom, "malicious txFrom stored verbatim, not executed");
  assert(stored.tx_data === maliciousData, "malicious txData stored verbatim, not executed");
  const countAfter = (fileDb.prepare("SELECT COUNT(*) AS c FROM execution_ledger").get() as { c: number }).c;
  assert(countAfter === 4, `row count is now 4 (3 real + 1 inert hostile) — got ${countAfter}`);

  // ── 6. File existence + size proof ────────────────────────────────────
  console.log("\n=== 6. The .db file on disk ===");
  execSync(`ls -la ${DB_PATH}*`, { stdio: "inherit" });
  const st = statSync(DB_PATH);
  assert(st.size > 0, `vantage ledger file exists and is non-empty (${st.size} bytes)`);

  fileDb.close();
  server.close();

  const passed = process.exitCode !== 1;
  console.log(`\n${passed ? "✅ EXECUTION MEMORY PROOF PASS" : "❌ SOME ASSERTIONS FAILED"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
