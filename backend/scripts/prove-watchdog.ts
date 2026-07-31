// Live proof of the Watchdog module end-to-end on Monad testnet.
//
// This spawns the REAL backend (src/server.ts) on a throwaway port and a temp
// SQLite DB, so the background polling loop runs exactly as it does in
// production: server.ts calls startWatchdog() only AFTER the HTTP listener is
// up (W.6). The proof then:
//
//   1. Adds the real deployed MockAMM to the watchlist via POST /api/watchlist.
//   2. Waits for 2+ distinct last_checked timestamps in the DB — real evidence
//      the loop polls on its own 15s cadence (nothing is triggered manually).
//   3. Calls manipulateReserves() on-chain to shift the token reserve +12%
//      (well over the 5% drift threshold) while the loop is running.
//   4. Waits for the NEXT background poll cycle and confirms a real
//      reserve_drift alert lands in the alerts table with the computed drift %.
//   5. Confirms GET /api/alerts and GET /api/alerts/summary return that same
//      alert over the real HTTP API, with correct unread/critical counts.
//
// Every alert row we inspect is written by the server's watchdog — this script
// never calls pollContract() / compareSnapshots() directly.
//
// Run from the backend/ directory with the parent .env loaded:
//   cd backend && set -a && . ../.env && set +a && \
//     node_modules/.bin/tsx scripts/prove-watchdog.ts
// (the script auto-loads ../.env if RPC_URL/PRIVATE_KEY are missing — see _env.ts)
import "./_env.js"; // MUST be first: loads .env before config.ts evaluates
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { config } from "../src/config.js";
import { MOCK_AMM_ADDRESS, mockAmmAbi } from "../src/psg/forecast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = resolve(__dirname, "..");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();
const LOG = (...a: unknown[]) => console.log(`[${ts()}]`, ...a);

const RESERVE_DRIFT_THRESHOLD_PCT = 5; // spec threshold — alert when |delta| > 5%
const SHIFT_PCT = 12; // we shift reserves +12% → comfortably > threshold, and critical
const DISTINCT_POLLS_REQUIRED = 2; // two real background polls before manipulating
const ALERT_WAIT_MS = 60_000; // generous upper bound for the next 15s cycle

// ── Helpers ─────────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess, log: string[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}) — output:\n${log.join("\n")}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms — output:\n${log.join("\n")}`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { privateKey, rpcUrl } = config;
  if (!privateKey) throw new Error("PRIVATE_KEY is not set in .env");
  if (!rpcUrl) throw new Error("RPC_URL is not set in .env");

  const amm = MOCK_AMM_ADDRESS as Address;
  if (!amm) throw new Error("MockAMM address missing from contracts/deployments.json");

  // Fresh throwaway DB + port so the proof never touches real dev state.
  const tmpDir = mkdtempSync(join(tmpdir(), "vantage-watchdog-proof-"));
  const dbPath = join(tmpDir, "watchdog.db");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let child: ChildProcess | null = null;
  let db: Database.Database | null = null;
  const serverLog: string[] = [];
  const cleanup = () => {
    try { child?.kill("SIGTERM"); } catch { /* ignore */ }
    try { db?.close(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  WATCHDOG LIVE PROOF — real server, real chain, real polls");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  AMM      = ${amm}`);
  console.log(`  port     = ${port}`);
  console.log(`  temp DB  = ${dbPath}`);

  try {
    // ── 0. Spawn the REAL backend. W.6: server.ts starts the watchdog inside
    //       the app.listen callback — after listening, never before. ─────────
    const tsxBin = resolve(BACKEND_DIR, "node_modules/.bin/tsx");
    const childEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: dbPath, PORT: String(port) };
    delete childEnv.VANTAGE_NO_LISTEN; // the server must actually listen
    child = spawn(tsxBin, ["src/server.ts"], {
      cwd: BACKEND_DIR,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d: Buffer) => { serverLog.push(d.toString()); process.stdout.write(d); });
    child.stderr!.on("data", (d: Buffer) => { serverLog.push(d.toString()); process.stderr.write(d); });

    LOG("spawned real backend (src/server.ts) — waiting for /health …");
    await waitForHealth(baseUrl, child, serverLog);
    LOG("server healthy on " + baseUrl);

    if (!serverLog.some((l) => l.includes("[watchdog] started"))) {
      throw new Error("server log has no '[watchdog] started' line — W.6 wiring missing?\n" + serverLog.join("\n"));
    }
    LOG("server log confirms '[watchdog] started' (started after listener was up)");

    // ── 1. Add the deployed MockAMM to the watchlist via the real API. ─────
    LOG("POST /api/watchlist { address: MockAMM, watchType: manual }");
    const addRes = await fetch(`${baseUrl}/api/watchlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: amm, watchType: "manual" }),
    });
    const addJson = (await addRes.json()) as { ok: boolean; added: boolean; address: string };
    LOG(`  → ${addRes.status} ok=${addJson.ok} added=${addJson.added} address=${addJson.address}`);
    if (addRes.status !== 201 || !addJson.ok) throw new Error("failed to add MockAMM to watchlist");
    if (!addJson.added) LOG("  (already watched — fine, idempotent)");

    // ── 2. Wait for 2+ distinct background polls, verified via last_checked
    //       timestamps in the DB. We never trigger a poll ourselves. ─────────
    db = new Database(dbPath, { readonly: true });
    const observed: string[] = [];
    let prevLastChecked: string | null = null;
    const pollDeadline = Date.now() + 75_000;
    LOG(`waiting for ${DISTINCT_POLLS_REQUIRED}+ distinct background polls (last_checked changes) …`);
    while (Date.now() < pollDeadline) {
      const row = db
        .prepare("SELECT last_checked FROM watchlist WHERE contract_address = ?")
        .get(amm) as { last_checked: string | null } | undefined;
      const lc = row?.last_checked ?? null;
      if (lc !== prevLastChecked) {
        observed.push(lc ?? "null");
        LOG(`  last_checked → ${lc ?? "null"}  (distinct #${observed.length})`);
        prevLastChecked = lc;
      }
      const distinctPolls = new Set(observed.filter((o) => o !== "null")).size;
      if (distinctPolls >= DISTINCT_POLLS_REQUIRED) break;
      await sleep(1_000);
    }
    const distinctPolls = new Set(observed.filter((o) => o !== "null")).size;
    LOG(`observed ${distinctPolls} distinct background poll(s) — ${observed.join(" → ")}`);
    if (distinctPolls < DISTINCT_POLLS_REQUIRED) {
      throw new Error(`expected >= ${DISTINCT_POLLS_REQUIRED} distinct polls, saw ${distinctPolls}`);
    }

    // ── 3. Shift the pool on-chain via manipulateReserves (owner-only; the
    //       .env key is the deployed MockAMM owner). +12% token reserve. ─────
    const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
    const account = privateKeyToAccount(`0x${privateKey}`);
    const wallet = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });

    const [tokBefore, monBefore] = (await publicClient.readContract({
      address: amm, abi: mockAmmAbi, functionName: "getReserves",
    })) as [bigint, bigint];
    const newToken = (tokBefore * BigInt(100 + SHIFT_PCT)) / 100n;
    // Float division so the expected drift is exact (bigint division truncates):
    // 399…061 → 447…028 is 11.9987%, not a clean 12%.
    const expectedDriftPct = (Number(newToken - tokBefore) / Number(tokBefore)) * 100;
    LOG(`reserves before = token ${tokBefore}, mon ${monBefore}`);
    LOG(`manipulateReserves(${newToken}, ${monBefore}) → token reserve +${SHIFT_PCT}% (expected drift ~${expectedDriftPct}%)`);

    const manipHash = await wallet.writeContract({
      address: amm, abi: mockAmmAbi, functionName: "manipulateReserves",
      args: [newToken, monBefore], gas: 200_000n,
    });
    LOG(`  tx ${manipHash}`);
    const manipReceipt = await publicClient.waitForTransactionReceipt({ hash: manipHash, timeout: 60_000 });
    const [tokAfter] = (await publicClient.readContract({
      address: amm, abi: mockAmmAbi, functionName: "getReserves",
    })) as [bigint, bigint];
    LOG(`  mined in block ${manipReceipt.blockNumber} (status=${manipReceipt.status}); reserves after = token ${tokAfter}`);
    if (manipReceipt.status !== "success") throw new Error("manipulateReserves reverted");
    if (tokAfter !== newToken) LOG("  (reserve drifted slightly between read and mine — expected drift recomputed below)");

    // ── 4. Wait for the NEXT background poll cycle — NOT triggered manually.
    //       The watchdog is the only writer of alerts rows, so any row that
    //       appears is proof a real poll ran after the manipulation. ─────────
    LOG(`waiting for the NEXT background poll to raise reserve_drift (up to ${ALERT_WAIT_MS / 1000}s) …`);
    const alertDeadline = Date.now() + ALERT_WAIT_MS;
    let alertRow: { id: string; type: string; severity: string; drift_pct: number | null; message: string; created_at: string } | undefined;
    while (Date.now() < alertDeadline) {
      alertRow = db
        .prepare(
          "SELECT id, type, severity, drift_pct, message, created_at FROM alerts WHERE contract_address = ? AND type = 'reserve_drift' ORDER BY created_at DESC LIMIT 1",
        )
        .get(amm) as typeof alertRow | undefined;
      if (alertRow) break;
      await sleep(1_000);
    }
    if (!alertRow) throw new Error("no reserve_drift alert appeared within the wait window — did the background poll run?");
    LOG(`reserve_drift alert raised at ${alertRow.created_at}`);
    LOG(`  severity=${alertRow.severity} drift_pct=${alertRow.drift_pct} message="${alertRow.message}"`);

    if (alertRow.severity !== "critical") throw new Error(`expected critical severity, got ${alertRow.severity}`);
    if (alertRow.drift_pct === null) throw new Error("reserve_drift alert has no drift_pct");
    const driftOk = alertRow.drift_pct > RESERVE_DRIFT_THRESHOLD_PCT && Math.abs(alertRow.drift_pct - expectedDriftPct) < 1.5;
    LOG(`  ✓ drift ${alertRow.drift_pct}% vs threshold ${RESERVE_DRIFT_THRESHOLD_PCT}% (expected ~${expectedDriftPct}%) → ${driftOk ? "PASS" : "FAIL"}`);
    if (!driftOk) throw new Error(`drift % out of expected range (alert=${alertRow.drift_pct}, expected≈${expectedDriftPct})`);

    // ── 5. GET /api/alerts returns that same alert via the real HTTP API. ───
    const alertsRes = await fetch(`${baseUrl}/api/alerts?address=${amm}&severity=critical`);
    const alertsJson = (await alertsRes.json()) as { items: Array<{ id: string; type: string; severity: string; message: string }> };
    const viaHttp = alertsJson.items.find((a) => a.id === alertRow!.id);
    LOG(`GET /api/alerts?address=…&severity=critical → ${alertsRes.status}, ${alertsJson.items.length} alert(s)`);
    if (!viaHttp) throw new Error("alert found in DB but not returned by GET /api/alerts");
    if (viaHttp.type !== "reserve_drift" || viaHttp.severity !== "critical") {
      throw new Error(`unexpected alert via HTTP: ${JSON.stringify(viaHttp)}`);
    }
    LOG(`  ✓ same alert (id=${viaHttp.id}) present via HTTP: type=${viaHttp.type} severity=${viaHttp.severity}`);
    LOG(`    message: ${viaHttp.message}`);

    // ── 6. GET /api/alerts/summary shows correct unread/critical counts. ────
    const summaryRes = await fetch(`${baseUrl}/api/alerts/summary`);
    const summary = (await summaryRes.json()) as {
      total: number; unread: number; critical: number; bySeverity: Record<string, number>;
    };
    LOG(`GET /api/alerts/summary → ${JSON.stringify(summary)}`);
    if (summary.critical < 1) throw new Error("summary critical count is 0 despite a critical alert");
    if (summary.unread < summary.critical) throw new Error("summary unread < critical (fresh critical alerts must be unread)");
    if ((summary.bySeverity.critical ?? 0) < 1) throw new Error("summary bySeverity.critical is 0");
    LOG("  ✓ summary has correct critical + unread counts");

    // ── Verdict ─────────────────────────────────────────────────────────────
    console.log("\n══════════════════════════════════════════════════════════════");
    console.log(`  ✅ WATCHDOG PROOF PASS — real reserve_drift alert (${alertRow.drift_pct}%) raised by a`);
    console.log(`     background poll cycle across ${distinctPolls}+ distinct polls, confirmed via DB + HTTP.`);
    console.log("══════════════════════════════════════════════════════════════");
  } catch (err) {
    console.error("\n❌ WATCHDOG PROOF FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    cleanup();
    // let the child's pipe flush before we exit
    await sleep(300);
  }
}

main();
