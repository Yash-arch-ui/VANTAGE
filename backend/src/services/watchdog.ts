// Watchdog — background contract monitor.
//
// Polls every watched contract on a fixed interval (15s for the demo) and
// raises alerts into the EM ledger. It REUSES the existing contention scanner
// (getContentionScore / getRecentActivity from psg/forecast.ts) and the
// EM calibrator (recalibrate) — there are no parallel copies of scanning or
// calibration logic here.
//
// Error contract: one contract's poll failure NEVER kills the loop. Every
// poll is isolated and logged; the next cycle proceeds regardless.
import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { config } from "../config.js";
import {
  mockAmmAbi,
  getContentionScore,
  getRecentActivity,
} from "../psg/forecast.js";
import { recalibrate } from "../em/calibrator.js";
import {
  getWatchlist,
  insertAlert,
  setLastChecked,
  getEntriesForContract,
} from "../em/ledger.js";

// ── Demo constants (from the spec) ──────────────────────────────────────

export const WATCH_POLL_INTERVAL_MS = 15_000; // 15s demo cadence
const RESERVE_DRIFT_THRESHOLD_PCT = 5; // alert when |reserve delta| > 5%
const RESERVE_DRIFT_CRITICAL_PCT = 10; // ...critical when >= 10%
const CONTENTION_SPIKE_MULTIPLIER = 3; // alert when contention >= 3x prior poll
const CONTENTION_SPIKE_FLOOR = 0.3; // ...and above the HIGH_CONTENTION floor
const FAILURE_SURGE_RATE = 0.25; // alert when failure rate > 25%
const FAILURE_SURGE_WINDOW_MINUTES = 60; // look-back for the failure rate
const INACTIVITY_WINDOW_MS = 10 * 60_000; // alert after 10min without logs

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

// ── Types ───────────────────────────────────────────────────────────────

type Client = ReturnType<typeof createPublicClient>;

type Reserves = { tokenReserve: bigint; monReserve: bigint };

/** What the watchdog remembers about a contract between polls. */
export type ContractSnapshot = {
  address: Address;
  tokenReserve: bigint | null;
  monReserve: bigint | null;
  contention: number | null;
  timestamp: number;
};

/** A detected condition, prior to dedup / persistence. */
export type AlertCandidate = {
  type: string;
  severity: string;
  message: string;
  driftPct?: number;
};

// ── Module state ────────────────────────────────────────────────────────

let _publicClient: Client | null = null;
let _observer: Address | null = null;

const snapshots = new Map<Address, ContractSnapshot>();

function getPublicClient(): Client {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: monadTestnet,
      transport: http(config.rpcUrl),
    });
  }
  return _publicClient;
}

/** The account the demo watches out for (its approvals are the exposure). */
function getObserverAddress(): Address {
  if (_observer) return _observer;
  if (config.privateKey) {
    try {
      _observer = privateKeyToAccount(`0x${config.privateKey}`).address;
      return _observer;
    } catch {
      // fall through to the zero address — approval checks simply read 0
    }
  }
  _observer = "0x0000000000000000000000000000000000000000";
  return _observer;
}

// ── Metric readers ──────────────────────────────────────────────────────

async function readReserves(client: Client, address: Address): Promise<Reserves | null> {
  try {
    const [tokenReserve, monReserve] = (await client.readContract({
      address,
      abi: mockAmmAbi,
      functionName: "getReserves",
    })) as [bigint, bigint];
    return { tokenReserve, monReserve };
  } catch {
    return null; // not an AMM — no reserve metrics
  }
}

/** Observer's outstanding ERC20 allowance to the watched contract, vs their balance. */
async function checkApprovalExposure(
  client: Client,
  contract: Address,
  observer: Address,
): Promise<{ ratio: number; allowance: bigint; balance: bigint } | null> {
  try {
    const token = (await client.readContract({
      address: contract,
      abi: mockAmmAbi,
      functionName: "token",
    })) as Address;
    const [balance, allowance] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [observer] }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [observer, contract] }),
    ]);
    if (balance === 0n) return null;
    const ratio = Number((allowance * 100n) / balance) / 100; // allowance as a multiple of balance
    return { ratio, allowance, balance };
  } catch {
    return null;
  }
}

// ── Snapshot comparison ─────────────────────────────────────────────────

function driftPct(prev: bigint, curr: bigint): number {
  if (prev === 0n) return 0;
  return Number(((curr - prev) * 10000n) / prev) / 100;
}

/**
 * Compare the previous poll's snapshot to the current observation and decide
 * the snapshot-derived alerts: reserve drift and contention spike. The other
 * three alert types (failure surge, approval exposure, inactivity) are checked
 * per-poll in pollContract — they don't need a prior snapshot.
 */
export function compareSnapshots(
  previous: ContractSnapshot | null,
  current: { tokenReserve: bigint | null; monReserve: bigint | null; contention: number | null },
): AlertCandidate[] {
  const alerts: AlertCandidate[] = [];

  // 1. Reserve drift — a shift between consecutive polls beyond the threshold.
  if (
    previous !== null &&
    previous.tokenReserve !== null &&
    current.tokenReserve !== null &&
    previous.tokenReserve !== 0n
  ) {
    const d = driftPct(previous.tokenReserve, current.tokenReserve);
    if (Math.abs(d) > RESERVE_DRIFT_THRESHOLD_PCT) {
      alerts.push({
        type: "reserve_drift",
        severity: Math.abs(d) >= RESERVE_DRIFT_CRITICAL_PCT ? "critical" : "warning",
        message: `Reserves moved ${d.toFixed(2)}% (token reserve ${previous.tokenReserve} → ${current.tokenReserve})`,
        driftPct: Math.round(d * 100) / 100,
      });
    }
  }

  // 2. Contention spike — at least 3x the prior poll's score and above the
  //    HIGH_CONTENTION floor, so quiet chains don't fire on noise.
  if (
    previous !== null &&
    previous.contention !== null &&
    current.contention !== null &&
    previous.contention > 0 &&
    current.contention >= CONTENTION_SPIKE_FLOOR &&
    current.contention >= previous.contention * CONTENTION_SPIKE_MULTIPLIER
  ) {
    alerts.push({
      type: "contention_spike",
      severity: "warning",
      message: `Contention spiked ${(current.contention / previous.contention).toFixed(1)}x to ${current.contention.toFixed(3)} (was ${previous.contention.toFixed(3)})`,
    });
  }

  return alerts;
}

// ── Per-contract poll ───────────────────────────────────────────────────

/**
 * Gather every metric for one contract, decide any alerts, and return the new
 * snapshot. Each metric is isolated so a failing RPC call on one dimension
 * (say, reserves on a non-AMM contract) degrades to "no data" rather than
 * aborting the poll.
 */
export async function pollContract(
  address: Address,
  previous: ContractSnapshot | null,
): Promise<{ snapshot: ContractSnapshot; alerts: AlertCandidate[] }> {
  const client = getPublicClient();
  const alerts: AlertCandidate[] = [];

  // 3. Failure surge — recent evaluation history from the EM ledger.
  try {
    const entries = getEntriesForContract(address, FAILURE_SURGE_WINDOW_MINUTES);
    if (entries.length > 0) {
      const failures = entries.filter(
        (e) => e.outcome === "FAILED" || e.policy_action === "ABORT",
      ).length;
      const rate = failures / entries.length;
      if (rate > FAILURE_SURGE_RATE) {
        alerts.push({
          type: "failure_surge",
          severity: "critical",
          message: `Recent failure rate ${(rate * 100).toFixed(1)}% (${failures}/${entries.length} in last ${FAILURE_SURGE_WINDOW_MINUTES}min) exceeds ${(FAILURE_SURGE_RATE * 100).toFixed(0)}%`,
        });
        // Let the real calibrator adapt the hold threshold to what we saw.
        recalibrate(address);
      }
    }
  } catch (err) {
    console.error(`[watchdog] failure_surge check failed for ${address}:`, err);
  }

  // 4. Approval exposure — the observer's outstanding allowance to the contract.
  try {
    const exposure = await checkApprovalExposure(client, address, getObserverAddress());
    if (exposure && exposure.allowance > 0n && exposure.ratio >= 0.5) {
      alerts.push({
        type: "approval_exposure",
        severity: "warning",
        message: `Observer has a large outstanding approval to this contract (allowance=${exposure.allowance}, balance=${exposure.balance}, ~${(exposure.ratio * 100).toFixed(0)}% of balance)`,
      });
    }
  } catch (err) {
    console.error(`[watchdog] approval_exposure check failed for ${address}:`, err);
  }

  // 5. Inactivity — no logs on the contract within the inactivity window.
  try {
    const activity = await getRecentActivity(client, address, INACTIVITY_WINDOW_MS);
    if (activity.logCount === 0) {
      alerts.push({
        type: "inactivity",
        severity: "info",
        message: `No contract activity in the last ${INACTIVITY_WINDOW_MS / 60_000} minutes`,
      });
    }
  } catch (err) {
    console.error(`[watchdog] inactivity check failed for ${address}:`, err);
  }

  // 1 + 2. Snapshot-derived alerts (reserve drift, contention spike).
  const [reserves, contention] = await Promise.all([
    readReserves(client, address),
    getContentionScore(address),
  ]);
  alerts.push(
    ...compareSnapshots(previous, {
      tokenReserve: reserves?.tokenReserve ?? null,
      monReserve: reserves?.monReserve ?? null,
      contention,
    }),
  );

  const snapshot: ContractSnapshot = {
    address,
    tokenReserve: reserves?.tokenReserve ?? null,
    monReserve: reserves?.monReserve ?? null,
    contention,
    timestamp: Date.now(),
  };

  return { snapshot, alerts };
}

// ── The loop ────────────────────────────────────────────────────────────

let cycle = 0;

/**
 * One full sweep over every watched contract. Any single contract's failure
 * is logged and skipped — it must never abort the sweep.
 */
async function pollAll(): Promise<void> {
  const watched = getWatchlist();
  cycle++;
  console.log(`[watchdog] poll cycle #${cycle} at ${new Date().toISOString()} — ${watched.length} watched contract(s)`);

  for (const row of watched) {
    const address = row.contract_address as Address;
    try {
      const previous = snapshots.get(address) ?? null;
      const { snapshot, alerts } = await pollContract(address, previous);
      snapshots.set(address, snapshot);
      setLastChecked(address, new Date().toISOString());

      for (const a of alerts) {
        const id = insertAlert({
          contractAddress: address,
          type: a.type,
          severity: a.severity,
          message: a.message,
          driftPct: a.driftPct,
        });
        console.log(
          `[watchdog] ALERT ${address} ${a.type} severity=${a.severity}${id ? ` id=${id}` : " (deduped)"} — ${a.message}`,
        );
      }

      console.log(
        `[watchdog]   ${address}: tokenReserve=${snapshot.tokenReserve ?? "n/a"} monReserve=${snapshot.monReserve ?? "n/a"} contention=${snapshot.contention?.toFixed(3) ?? "n/a"} checked at ${new Date().toISOString()}`,
      );
    } catch (err) {
      // One bad contract must never kill the loop.
      console.error(`[watchdog] poll failed for ${address} — continuing:`, err);
    }
  }
}

/**
 * Start the background polling loop. Polls immediately (so a fresh watchlist
 * entry gets a baseline without waiting a full interval), then every
 * `pollIntervalMs`. Returns a handle to stop the loop.
 */
export function startWatchdog(
  options: { pollIntervalMs?: number } = {},
): { stop: () => void } {
  const pollIntervalMs = options.pollIntervalMs ?? WATCH_POLL_INTERVAL_MS;

  void pollAll().catch((err) =>
    console.error("[watchdog] poll cycle failed:", err),
  );

  const timer = setInterval(() => {
    void pollAll().catch((err) =>
      console.error("[watchdog] poll cycle failed:", err),
    );
  }, pollIntervalMs);
  timer.unref?.(); // don't keep the process alive solely for the watchdog

  return { stop: () => clearInterval(timer) };
}
