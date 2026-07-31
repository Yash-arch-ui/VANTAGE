import {
  createPublicClient,
  http,
  type Hex,
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

  // riskLevel === "CRITICAL"
  const detail = revertReason ?? "unknown revert";
  return { action: "ABORT", reason: `Simulation reverted: ${detail}` };
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
): Promise<PolicyResult> {
  const intervalMs = options?.intervalMs ?? 3_000;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const forecast = await getPSGForecast(tx, quotedOutput);
      const result = decidePolicy(forecast);

      if (result.action !== "HOLD_AND_RECHECK") {
        return result;
      }
    } catch {
      // Transient RPC error — continue polling
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  return {
    action: "SUGGEST_ADJUSTMENT",
    reason: "Contention did not clear within timeout.",
    suggestedAdjustment:
      "Try increasing gas or waiting for network activity to settle.",
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
      const receipt: TransactionReceipt | null = await client
        .getTransactionReceipt({ hash: txHash })
        .catch(() => null);

      if (receipt) {
        options?.onIteration?.({ iteration, elapsedMs, hasReceipt: true, txKnown: null });

        if (receipt.status === "success") {
          return { status: "CONFIRMED", secondsPending: elapsed };
        }

        // status === 'reverted' — try to extract the revert reason
        let revertReason: string | undefined;
        try {
          const failedTx = await client
            .getTransaction({ hash: txHash })
            .catch(() => null);

          if (failedTx && receipt.blockNumber !== null) {
            // Re-execute as eth_call pinned to the exact block the tx
            // failed in, so state changes that happened *after* do not
            // alter or mask the real revert reason.
            try {
              // `account` (not `from`) sets the eth_call sender — viem drops
              // `from` from the request, which would re-run the call as
              // address(0) and mask the real revert reason.
              await client.call({
                account: failedTx.from,
                to: failedTx.to,
                data: failedTx.input,
                value: failedTx.value,
                blockNumber: receipt.blockNumber,
              } as Parameters<typeof client.call>[0]);
            } catch (callErr: unknown) {
              revertReason = decodeRevertReason(callErr);
            }
          }
        } catch {
          // No additional info available
        }

        return { status: "FAILED", secondsPending: elapsed, revertReason };
      }

      // No receipt yet — check if the tx is still known to the node
      const tx = await client
        .getTransaction({ hash: txHash })
        .catch(() => null);

      options?.onIteration?.({
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
      // RPC error mid-poll — do not abort, keep trying
      options?.onIteration?.({
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
