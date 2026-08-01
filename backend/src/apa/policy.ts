import {
  createPublicClient,
  http,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
  type Transaction,
  type TransactionReceipt,
} from "viem";
import { monadTestnet } from "viem/chains";
import { GoogleGenAI, Type } from "@google/genai";
import { config } from "../config.js";
import {
  type PSGForecast,
  type VantageTxRequest,
  getPSGForecast,
  decodeRevertReason,
} from "../psg/forecast.js";

const genAI = new GoogleGenAI({});

// ── Initialization ────────────────────────────────────────────────────

const { rpcUrl } = config;

let _publicClient: ReturnType<typeof createPublicClient> | null = null;

function getPublicClient(): ReturnType<typeof createPublicClient> | null {
  if (_publicClient) return _publicClient;
  if (!rpcUrl) return null;
  try {
    _publicClient = createPublicClient({
      chain: monadTestnet,
      transport: http(rpcUrl),
    });
    return _publicClient;
  } catch {
    return null;
  }
}

// ── Types ──────────────────────────────────────────────────────────────

export type PolicyAction =
  | "PROCEED"
  | "WARN"
  | "HOLD_AND_RECHECK"
  | "SUGGEST_ADJUSTMENT"
  | "ABORT";

export type PolicyResult = {
  action: PolicyAction;
  reason: string;
  suggestedAdjustment?: string;
};

export type TxWatchStatus =
  | "CONFIRMED"
  | "FAILED"
  | "NULL_PENDING"
  | "DROPPED"
  | "STUCK";

export type WatchResult = {
  status: TxWatchStatus;
  secondsPending: number;
  revertReason?: string;
};

// ── 1. Decision Logic ──────────────────────────────────────────────────

/**
 * Pure decision function — reads riskLevel + flags from a PSGForecast
 * and resolves to a policy action.  Never throws.
 */
export function decidePolicy(forecast: PSGForecast): PolicyResult {
  const { riskLevel, flags, revertReason, outputDriftPercent } = forecast;

  if (riskLevel === "LOW" && flags.length === 0) {
    return { action: "PROCEED", reason: "All signals clear; no flags raised." };
  }

  if (riskLevel === "MEDIUM") {
    const detail = flags.length
      ? ` Flags: ${flags.join(", ")}.`
      : " No specific flags raised.";
    return { action: "WARN", reason: `Risk level MEDIUM.${detail}` };
  }

  if (riskLevel === "HIGH") {
    if (flags.includes("HIGH_CONTENTION")) {
      return {
        action: "HOLD_AND_RECHECK",
        reason: `Contention score ${forecast.contentionScore?.toFixed(2) ?? "N/A"} exceeds threshold. Pausing for recheck.`,
      };
    }
    if (flags.includes("STALE_STATE")) {
      const drift = outputDriftPercent !== null
        ? `drift ${outputDriftPercent.toFixed(2)}%`
        : "unexpected drift";
      return { action: "WARN", reason: `Stale state detected (${drift}). Proceed with caution.` };
    }
    if (flags.includes("NONCE_GAP") || flags.includes("NONCE_STALE") || flags.includes("LOW_BALANCE")) {
      const issue = flags.includes("NONCE_GAP") ? "nonce gap" :
                    flags.includes("NONCE_STALE") ? "stale nonce" :
                    "insufficient balance";
      return { action: "ABORT", reason: `Unsafe to submit: ${issue}.` };
    }
    // Safe fallback for any other HIGH case not explicitly covered
    return { action: "WARN", reason: `Unhandled HIGH risk. Flags: ${flags.join(", ")}.` };
  }

  if (riskLevel === "CRITICAL") {
    const detail = revertReason ?? "unknown revert";
    return { action: "ABORT", reason: `Simulation reverted: ${detail}` };
  }

  // Everything else — in practice a LOW forecast carrying flags, since the LOW
  // branch above requires none. This used to fall through to the CRITICAL tail
  // and abort a clean transaction while inventing "Simulation reverted: unknown
  // revert" as the justification. Warn on the flags we actually have instead of
  // asserting a revert that never happened.
  return {
    action: "WARN",
    reason: `Risk level ${riskLevel} with flags: ${flags.join(", ")}. Review before submitting.`,
  };
}

/**
 * Bias a finalized policy decision toward caution when the watchdog has active
 * (undismissed) critical alerts on the target contract — the APA integration.
 *
 * The alert query itself lives in the caller (evaluate.ts reads the ledger via
 * getActiveCriticalAlertCount) so this function stays pure policy, as unit-
 * testable as decidePolicy.
 *
 *   activeCriticalAlerts <= 0            → result returned unchanged
 *   action === PROCEED                   → WARN (a clean simulation must not
 *                                           paper over a known on-chain alert)
 *   WARN / HOLD / SUGGEST / ABORT        → action unchanged, reason annotated
 */
export function applyWatchdogBias(
  result: PolicyResult,
  activeCriticalAlerts: number,
): PolicyResult {
  if (!(activeCriticalAlerts > 0)) {
    return result;
  }
  const note = `Watchdog: ${activeCriticalAlerts} active critical alert(s) on this contract. ${result.reason}`;
  if (result.action === "PROCEED") {
    return { action: "WARN", reason: note };
  }
  return { ...result, reason: note };
}

// ── 2. Hold & Recheck Loop ────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type HoldRecheckOptions = {
  intervalMs?: number;
  timeoutMs?: number;
};

export type HoldRecheckResult = {
  policy: PolicyResult;
  /**
   * The forecast the returned policy was actually derived from, or null when
   * the hold timed out without a usable re-check.
   *
   * This is returned, not discarded, because the caller must not pair a fresh
   * decision with the stale forecast that triggered the hold: contention
   * clearing would otherwise produce a PROCEED verdict displayed and recorded
   * alongside riskLevel HIGH and flags ["HIGH_CONTENTION"] — an audit row whose
   * own evidence contradicts its decision.
   */
  forecast: PSGForecast | null;
};

/**
 * Poll `getPSGForecast` on an interval until the action resolves away from
 * HOLD_AND_RECHECK, or until the timeout is reached.
 *
 * Never throws.  Transient RPC errors are caught silently per-iteration.
 */
export async function holdAndRecheck(
  tx: VantageTxRequest,
  quotedOutput: bigint | undefined,
  options?: HoldRecheckOptions,
): Promise<HoldRecheckResult> {
  const intervalMs = options?.intervalMs ?? 3_000;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  // Kept so a timeout still reports the freshest picture we managed to get,
  // rather than the one from before the wait.
  let latest: PSGForecast | null = null;

  while (Date.now() < deadline) {
    try {
      const forecast = await getPSGForecast(tx, quotedOutput);
      latest = forecast;
      const result = decidePolicy(forecast);

      if (result.action !== "HOLD_AND_RECHECK") {
        return { policy: result, forecast };
      }
    } catch {
      // Transient RPC error — continue polling
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  return {
    policy: {
      action: "SUGGEST_ADJUSTMENT",
      reason: "Contention did not clear within timeout.",
      suggestedAdjustment:
        "Try increasing gas or waiting for network activity to settle.",
    },
    forecast: latest,
  };
}

// ── 3. Post-Submission Vanishing-Tx Watcher ────────────────────────────

export type WatchPoll = {
  /** 1-based poll number within this watch. */
  iteration: number;
  /** Milliseconds since watchTransaction started. */
  elapsedMs: number;
  /** Whether this iteration already found a mined receipt. */
  hasReceipt: boolean;
  /** Mempool visibility when no receipt yet — null when a receipt was found or on an RPC error. */
  txKnown: boolean | null;
  /** Set when this iteration hit a transient RPC error and kept polling. */
  error?: string;
};

export type WatchTransactionOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Invoked on every poll iteration — lets callers observe real polling (timestamps, mempool state). */
  onIteration?: (poll: WatchPoll) => void;
};

/**
 * A submitted tx that the RPC never surfaces as pending (and that never
 * mines) is treated as dropped after this long. Before this window, "not
 * visible" is assumed to be node visibility lag, not an eviction — some
 * RPCs (e.g. Monad testnet) don't return freshly-submitted pending txs from
 * eth_getTransactionByHash.
 */
const NEVER_SEEN_GRACE_MS = 10_000;

/**
 * The outcome of one chain lookup.
 *
 * `.catch(() => null)` cannot express the distinction that matters here: "the
 * node says this transaction does not exist" and "the node did not answer" are
 * completely different facts, and collapsing them makes an RPC outage look like
 * evidence that a transaction was dropped.
 */
type Lookup<T> = { reachable: true; value: T | null } | { reachable: false };

/**
 * Invoke the caller's observer without letting it break the watch.
 *
 * watchTransaction documents that it never throws, but one of these calls sits
 * inside the catch block, so a throwing observer there propagated straight out.
 * An observer is for reporting progress; it must never decide the outcome.
 */
function notifyIteration(options: WatchTransactionOptions | undefined, poll: WatchPoll): void {
  try {
    options?.onIteration?.(poll);
  } catch (err) {
    console.error("[watch] onIteration callback threw — continuing:", err);
  }
}

/** Not-found is an answer; anything else means we could not see the chain. */
async function lookupReceipt(
  client: NonNullable<ReturnType<typeof getPublicClient>>,
  txHash: Hex,
): Promise<Lookup<TransactionReceipt>> {
  try {
    return { reachable: true, value: await client.getTransactionReceipt({ hash: txHash }) };
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return { reachable: true, value: null };
    return { reachable: false };
  }
}

async function lookupTransaction(
  client: NonNullable<ReturnType<typeof getPublicClient>>,
  txHash: Hex,
): Promise<Lookup<Transaction>> {
  try {
    return { reachable: true, value: await client.getTransaction({ hash: txHash }) };
  } catch (err) {
    if (err instanceof TransactionNotFoundError) return { reachable: true, value: null };
    return { reachable: false };
  }
}

/**
 * Re-run a reverted transaction as an eth_call pinned to the exact block it
 * failed in, so state changes that happened *after* cannot alter or mask the
 * real revert reason. Returns undefined when nothing could be extracted.
 */
async function extractRevertReason(
  client: NonNullable<ReturnType<typeof getPublicClient>>,
  txHash: Hex,
  receipt: TransactionReceipt,
): Promise<string | undefined> {
  try {
    const failedTx = await client.getTransaction({ hash: txHash }).catch(() => null);
    if (!failedTx || receipt.blockNumber === null) return undefined;

    try {
      // `account` (not `from`) sets the eth_call sender — viem drops `from`
      // from the request, which would re-run the call as address(0) and mask
      // the real revert reason.
      await client.call({
        account: failedTx.from,
        to: failedTx.to,
        data: failedTx.input,
        value: failedTx.value,
        blockNumber: receipt.blockNumber,
      } as Parameters<typeof client.call>[0]);
    } catch (callErr: unknown) {
      return decodeRevertReason(callErr);
    }
  } catch {
    // No additional info available
  }
  return undefined;
}

/**
 * Watch a submitted transaction until it confirms, fails, disappears, or
 * times out.  Polls every 2 seconds up to 60 seconds total.
 *
 * Never throws — all RPC errors are caught mid-poll and only surfaced as a
 * STUCK status if the deadline expires.
 */
export async function watchTransaction(
  txHash: Hex,
  options?: WatchTransactionOptions
): Promise<WatchResult> {
  const client = getPublicClient();
  const startedAt = Date.now();
  const deadline = startedAt + (options?.timeoutMs ?? 60_000);
  const pollIntervalMs = options?.pollIntervalMs ?? 2_000;

  if (!client) {
    return {
      status: "STUCK",
      secondsPending: 0,
      revertReason: "No RPC URL configured",
    };
  }

  let iteration = 0;
  let everKnown = false; // has the tx ever been observed as pending in the mempool?
  while (Date.now() < deadline) {
    iteration++;
    const elapsedMs = Date.now() - startedAt;
    const elapsed = Math.floor(elapsedMs / 1000);

    try {
      const receiptLookup = await lookupReceipt(client, txHash);
      if (!receiptLookup.reachable) {
        // Could not see the chain this poll. Report it as an RPC error and keep
        // trying — treating it as "no receipt" would let the not-found branch
        // below conclude the transaction was evicted.
        notifyIteration(options, {
          iteration,
          elapsedMs,
          hasReceipt: false,
          txKnown: null,
          error: "rpc",
        });
        const wait = deadline - Date.now();
        if (wait <= 0) break;
        await sleep(Math.min(pollIntervalMs, wait));
        continue;
      }
      const receipt: TransactionReceipt | null = receiptLookup.value;

      if (receipt) {
        notifyIteration(options, { iteration, elapsedMs, hasReceipt: true, txKnown: null });

        if (receipt.status === "success") {
          return { status: "CONFIRMED", secondsPending: elapsed };
        }

        // status === 'reverted' — try to extract the revert reason
        const revertReason = await extractRevertReason(client, txHash, receipt);

        return { status: "FAILED", secondsPending: elapsed, revertReason };
      }

      // No receipt yet — check if the tx is still known to the node
      const txLookup = await lookupTransaction(client, txHash);
      if (!txLookup.reachable) {
        notifyIteration(options, {
          iteration,
          elapsedMs,
          hasReceipt: false,
          txKnown: null,
          error: "rpc",
        });
        const wait = deadline - Date.now();
        if (wait <= 0) break;
        await sleep(Math.min(pollIntervalMs, wait));
        continue;
      }
      const tx = txLookup.value;

      notifyIteration(options, {
        iteration,
        elapsedMs,
        hasReceipt: false,
        txKnown: tx !== null,
      });

      if (!tx) {
        // DROPPED only when the tx is really gone: either it was previously
        // observed pending and has now vanished (genuine eviction), or it
        // never surfaced in the pool we can see AND enough time has passed
        // that it would have mined by now if it were going to. A fresh tx the
        // RPC hasn't surfaced yet is a visibility lag, not an eviction.
        if (everKnown || elapsedMs >= NEVER_SEEN_GRACE_MS) {
          return { status: "DROPPED", secondsPending: elapsed };
        }
        // Keep polling — the node may simply not have surfaced the tx yet.
      } else {
        everKnown = true;
      }

      // Tx still pending in the mempool — keep waiting
    } catch {
      // Unexpected error mid-poll — do not abort, keep trying
      notifyIteration(options, {
        iteration,
        elapsedMs,
        hasReceipt: false,
        txKnown: null,
        error: "rpc",
      });
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  const secondsPending = Math.floor((Date.now() - startedAt) / 1000);
  return { status: "STUCK", secondsPending };
}

/**
 * A transaction that has been pending this long without mining is no longer
 * "just async" — it is stuck (nonce gap, underpriced, or the node is wedged).
 */
const STUCK_AFTER_MS = 45_000;

export type TxStatusReport = WatchResult & {
  /** What the user should actually do about this status. */
  recommendation: string;
};

/**
 * Single-shot version of {@link watchTransaction}: classifies a transaction
 * from ONE round of RPC calls and returns immediately.
 *
 * watchTransaction blocks for up to 60 seconds, which is fine for a script but
 * not for an HTTP handler. This variant lets a client poll on its own cadence
 * and keep a responsive UI.
 *
 * `submittedAtMs` (when the tx was broadcast) is required, not optional: a
 * stateless request has no other way to know how long the transaction has been
 * outstanding, and defaulting it to now makes elapsed time permanently zero —
 * which silently renders both DROPPED and STUCK unreachable and reports every
 * transaction as still propagating forever.
 *
 * Never throws — an unreachable node degrades to NULL_PENDING, because "we
 * could not see the chain" must never be reported to a user as "your
 * transaction was dropped". That distinction is why the lookups above separate
 * a not-found answer from a transport failure.
 */
export async function classifyTx(
  txHash: Hex,
  submittedAtMs: number,
): Promise<TxStatusReport> {
  const client = getPublicClient();
  const elapsedMs = Math.max(0, Date.now() - submittedAtMs);
  const secondsPending = Math.floor(elapsedMs / 1000);

  /** Not knowing is never evidence that the transaction is gone. */
  const unknown = (why: string): TxStatusReport => ({
    status: "NULL_PENDING",
    secondsPending,
    recommendation: why,
  });

  if (!client) {
    return unknown(
      "The backend has no RPC endpoint configured, so the status could not be checked.",
    );
  }

  try {
    const receiptLookup = await lookupReceipt(client, txHash);
    if (!receiptLookup.reachable) {
      return unknown("Could not reach the node this poll. Status is unchanged — retry shortly.");
    }
    const receipt = receiptLookup.value;

    if (receipt) {
      if (receipt.status === "success") {
        return {
          status: "CONFIRMED",
          secondsPending,
          recommendation: "Transaction confirmed on-chain. Nothing further to do.",
        };
      }
      const revertReason = await extractRevertReason(client, txHash, receipt);
      return {
        status: "FAILED",
        secondsPending,
        revertReason,
        recommendation: revertReason
          ? `Transaction reverted: ${revertReason}. Fix the cause before resubmitting.`
          : "Transaction reverted on-chain. Do not blindly resubmit — re-simulate first.",
      };
    }

    const txLookup = await lookupTransaction(client, txHash);
    if (!txLookup.reachable) {
      return unknown("Could not reach the node this poll. Status is unchanged — retry shortly.");
    }

    if (!txLookup.value) {
      // Not visible anywhere. Before the grace window this is Monad's async
      // propagation, not an eviction — the single most common way naive
      // polling logic reports a false "dropped".
      if (elapsedMs < NEVER_SEEN_GRACE_MS) {
        return unknown(
          "The node has not surfaced this transaction yet. This is normal on an async mempool — keep waiting.",
        );
      }
      return {
        status: "DROPPED",
        secondsPending,
        recommendation: "The transaction is no longer known to the node. Resubmit it.",
      };
    }

    if (elapsedMs >= STUCK_AFTER_MS) {
      return {
        status: "STUCK",
        secondsPending,
        recommendation:
          "Still pending well past the expected inclusion time — likely underpriced or blocked by an earlier nonce. Consider a replacement transaction.",
      };
    }

    return {
      status: "NULL_PENDING",
      secondsPending,
      recommendation: "Pending in the mempool and propagating normally. Keep waiting.",
    };
  } catch {
    // An RPC failure is our problem, not evidence about the transaction.
    return {
      status: "NULL_PENDING",
      secondsPending,
      recommendation: "Could not reach the node this poll. Status is unchanged — retry shortly.",
    };
  }
}

// ── 4. AI Explainer ────────────────────────────────────────────────────

/**
 * Deterministic fallback sentence built purely from the forecast + policy
 * fields.  Used when no AI API key is configured or the API call fails.
 */
function templateExplain(forecast: PSGForecast, policy: PolicyResult): string {
  const { action } = policy;

  switch (action) {
    case "PROCEED":
      return "All risk signals are clear. The transaction is ready to submit.";

    case "WARN": {
      if (forecast.flags.includes("STALE_STATE")) {
        return `The quoted price has drifted ${Math.abs(forecast.outputDriftPercent ?? 0).toFixed(2)}% from the on-chain simulation. Proceeding may result in a different execution price than expected.`;
      }
      const details = forecast.flags.length
        ? ` Flags: ${forecast.flags.join(", ")}.`
        : "";
      return `Risk level is MEDIUM.${details} Proceed with caution.`;
    }

    case "HOLD_AND_RECHECK":
      return `Network contention is high (score: ${forecast.contentionScore?.toFixed(2) ?? "N/A"}). Waiting for activity to settle before retrying the simulation.`;

    case "SUGGEST_ADJUSTMENT":
      return policy.suggestedAdjustment ??
        "Contention did not clear. Consider adjusting gas or timing.";

    case "ABORT": {
      if (forecast.revertReason) {
        return `The simulation reverted with reason: "${forecast.revertReason}". The transaction cannot be submitted in its current form.`;
      }
      if (forecast.flags.includes("NONCE_GAP")) {
        return "A nonce gap was detected — a prior transaction with a lower nonce has not yet been mined. Wait for it to confirm before submitting.";
      }
      if (forecast.flags.includes("NONCE_STALE")) {
        return "The transaction nonce has already been used. Increment the nonce and re-sign before submitting.";
      }
      if (forecast.flags.includes("LOW_BALANCE")) {
        return "Insufficient balance to cover gas. Estimated cost exceeds available funds.";
      }
      return "Unsafe conditions detected — transaction cannot be submitted.";
    }
  }
}

/**
 * Call Google's Gemini API to produce a single plain-English explanation
 * sentence.  Falls back to the deterministic template if no API key is
 * configured or the request fails.
 *
 * Never throws — always returns a string.
 */
export async function explainPolicy(
  forecast: PSGForecast,
  policy: PolicyResult,
): Promise<string> {
  // SDK auto-picks up process.env.GEMINI_API_KEY
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return templateExplain(forecast, policy);
  }

  // Build a minimal input payload — only non-null fields
  const payload: Record<string, unknown> = {
    action: policy.action,
    riskLevel: forecast.riskLevel,
    flags: forecast.flags,
  };
  for (const [key, val] of Object.entries({
    revertReason: forecast.revertReason,
    outputDriftPercent: forecast.outputDriftPercent,
    quotedOutput: forecast.quotedOutput,
    simulatedOutput: forecast.simulatedOutput,
    contentionScore: forecast.contentionScore,
    balanceSufficient: forecast.balanceSufficient,
    nonceCurrent: forecast.nonceCurrent,
    nonceIssue: forecast.nonceIssue,
  })) {
    if (val !== null && val !== undefined) payload[key] = val;
  }

  try {
    const response = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Transaction risk data: ${JSON.stringify(payload)}`,
      config: {
        systemInstruction:
          "Given this transaction risk data, write exactly one plain-English sentence explaining what is happening and why, using only the metrics provided. Do not invent numbers or claims.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            explanation: { type: Type.STRING },
            riskLevel: {
              type: Type.STRING,
              enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
            },
          },
          required: ["explanation", "riskLevel"],
        },
      },
    });

    const text = response.text;
    if (!text) return templateExplain(forecast, policy);

    const result = JSON.parse(text) as {
      explanation?: string;
      riskLevel?: string;
    };
    return result.explanation?.trim() ?? templateExplain(forecast, policy);
  } catch {
    return templateExplain(forecast, policy);
  }
}
