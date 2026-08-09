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
  maxUint256,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { config } from "../config.js";
import {
  ammAbi,
  getContentionScore,
  getRecentActivity,
} from "../psg/forecast.js";
import { recalibrate } from "../em/calibrator.js";
import {
  getWatchlist,
  insertAlert,
  setLastChecked,
  getEntriesForContract,
  resolveAlerts,
  expireStaleAlerts,
  pruneAutoWatchlist,
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

/**
 * Last time each contract's hold threshold was recalibrated from watchdog
 * observations. Calibration is meant to be event-driven (one real outcome, one
 * adjustment); without a cooldown the poll loop turns it into exponential decay.
 */
const lastRecalibrated = new Map<Address, number>();

/** Roughly one adjustment per failure-surge window, not one per poll. */
const RECALIBRATE_COOLDOWN_MS = 5 * 60_000;

function getPublicClient(): Client {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: monadTestnet,
      transport: http(config.rpcUrl, { timeout: 15_000 }),
    });
  }
  return _publicClient;
}

/** The account the demo watches out for (its approvals are the exposure). */
function getObserverAddress(): Address {
  if (_observer) return _observer;
  if (config.privateKey) {
    try {
      // Tolerate a key that already carries the prefix. Blindly prepending
      // produced "0x0x…", which threw and fell through to the zero address with
      // no log at all — approval_exposure then read an allowance of 0 for every
      // contract and silently never fired again.
      const key = config.privateKey.startsWith("0x")
        ? config.privateKey
        : `0x${config.privateKey}`;
      _observer = privateKeyToAccount(key as `0x${string}`).address;
      return _observer;
    } catch (err) {
      console.error(
        "[watchdog] PRIVATE_KEY is not a valid key — approval-exposure alerts are disabled:",
        err,
      );
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
      abi: ammAbi,
      functionName: "getReserves",
    })) as [bigint, bigint];
    return { tokenReserve, monReserve };
  } catch (err) {
    // Ambiguous by nature: a non-AMM contract and an unreachable node look the
    // same here. Log it so a silent monitoring outage is at least visible —
    // reserve-drift detection switches off for this contract either way.
    console.debug(`[watchdog] no reserves for ${address} (not an AMM, or the read failed):`, err);
    return null;
  }
}

/** Observer's outstanding ERC20 allowance to the watched contract, vs their balance. */
function formatApprovalPct(allowance: bigint, ratio: number): string {
  if (allowance >= maxUint256) return "unlimited (max uint256)";
  const pct = ratio * 100;
  if (pct > 1000) return ">1000%";
  return `${pct.toFixed(0)}%`;
}

async function checkApprovalExposure(
  client: Client,
  contract: Address,
  observer: Address,
): Promise<{ ratio: number; allowance: bigint; balance: bigint } | null> {
  try {
    const token = (await client.readContract({
      address: contract,
      abi: ammAbi,
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
): Promise<{ snapshot: ContractSnapshot; alerts: AlertCandidate[]; cleared: string[] }> {
  const client = getPublicClient();
  const alerts: AlertCandidate[] = [];
  // Conditions this poll positively observed to be absent. An alert is a claim
  // about the present, so an observation that the condition has gone is what
  // retracts it.
  const cleared: string[] = [];

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
        // Let the real calibrator adapt the hold threshold to what we saw —
        // but at most once per cooldown. This used to run on every cycle while
        // the rate stayed high, multiplying the threshold by 0.9 four times a
        // minute and driving 0.7 to the 0.3 floor in under two minutes, purely
        // as a function of wall-clock time against a ledger window whose
        // contents had not changed at all.
        const lastCalibrated = lastRecalibrated.get(address) ?? 0;
        if (Date.now() - lastCalibrated >= RECALIBRATE_COOLDOWN_MS) {
          recalibrate(address);
          lastRecalibrated.set(address, Date.now());
        }
      } else {
        cleared.push("failure_surge");
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
        message: `Observer has a large outstanding approval to this contract (allowance=${exposure.allowance}, balance=${exposure.balance}, ~${formatApprovalPct(exposure.allowance, exposure.ratio)} of balance)`,
      });
    } else if (exposure) {
      // The allowance was readable and is no longer excessive — revoked, spent
      // down, or the balance grew past it.
      cleared.push("approval_exposure");
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
    } else {
      cleared.push("inactivity");
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

  return { snapshot, alerts, cleared };
}

// ── The loop ────────────────────────────────────────────────────────────

let cycle = 0;

/**
 * One full sweep over every watched contract. Any single contract's failure
 * is logged and skipped — it must never abort the sweep.
 */
/**
 * An alert nobody has re-observed for this long is retired. A condition can
 * stop being observable without the watchdog ever seeing it clear — the
 * contract leaves the watchlist, the RPC is down for a stretch, the process
 * restarts — and those alerts would otherwise degrade the contract's score
 * forever.
 */
const ALERT_MAX_AGE_MS = 60 * 60_000;

/**
 * Upper bound on auto-watched contracts. Each one costs ~25-30 RPC round-trips
 * per cycle, so without a ceiling the sweep eventually cannot finish inside its
 * own interval. Manual entries are never counted or evicted.
 */
const MAX_AUTO_WATCHED = 25;

async function pollAll(): Promise<void> {
  const evicted = pruneAutoWatchlist(MAX_AUTO_WATCHED);
  if (evicted > 0) {
    console.log(`[watchdog] evicted ${evicted} least-recent auto-watched contract(s)`);
  }

  const watched = getWatchlist();
  cycle++;

  const expired = expireStaleAlerts(ALERT_MAX_AGE_MS);
  if (expired > 0) {
    console.log(`[watchdog] expired ${expired} stale alert(s) older than ${ALERT_MAX_AGE_MS / 60_000}min`);
  }
  console.log(`[watchdog] poll cycle #${cycle} at ${new Date().toISOString()} — ${watched.length} watched contract(s)`);

  // Forget contracts that are no longer watched. `snapshots` was write-only, so
  // it grew for the lifetime of the process and held reserve baselines for
  // contracts that had been removed.
  const live = new Set(watched.map((row) => row.contract_address.toLowerCase()));
  for (const key of snapshots.keys()) {
    if (!live.has(key.toLowerCase())) {
      snapshots.delete(key);
      lastRecalibrated.delete(key);
    }
  }

  for (const row of watched) {
    const address = row.contract_address as Address;
    try {
      const previous = snapshots.get(address) ?? null;
      const { snapshot, alerts, cleared } = await pollContract(address, previous);
      snapshots.set(address, snapshot);
      setLastChecked(address, new Date().toISOString());

      // Retract alerts whose condition this poll observed to be gone. Without
      // this an alert lived until a human dismissed it, so a single transient
      // failure surge biased every later verdict on the contract to WARN and
      // held its score down permanently.
      for (const type of cleared) {
        const resolved = resolveAlerts(address, type);
        if (resolved > 0) {
          console.log(`[watchdog] RESOLVED ${address} ${type} — condition no longer present`);
        }
      }

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

  // A single contract costs ~25-30 RPC round-trips per cycle (getRecentActivity
  // alone chunks a 10-minute window into ~19 eth_getLogs), so on a public RPC a
  // cycle can easily outrun the 15s interval. Without this guard cycles stacked
  // and their `snapshots.set` writes raced — a slow cycle finishing late would
  // overwrite a newer baseline, and the next comparison would diff against the
  // wrong reserves and emit phantom drift alerts.
  let inFlight = false;

  const runCycle = (): void => {
    if (inFlight) {
      console.warn("[watchdog] previous cycle still running — skipping this tick");
      return;
    }
    inFlight = true;
    void pollAll()
      .catch((err) => console.error("[watchdog] poll cycle failed:", err))
      .finally(() => {
        inFlight = false;
      });
  };

  runCycle();

  const timer = setInterval(runCycle, pollIntervalMs);
  timer.unref?.(); // don't keep the process alive solely for the watchdog

  return { stop: () => clearInterval(timer) };
}
