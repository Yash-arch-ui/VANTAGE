import {
  createPublicClient,
  http,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { monadTestnet } from "viem/chains";
import { config } from "../config.js";
import {
  type PSGForecast,
  type VantageTxRequest,
  getPSGForecast,
  decodeRevertReason,
} from "../psg/forecast.js";

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

/**
 * Watch a submitted transaction until it confirms, fails, disappears, or
 * times out.  Polls every 2 seconds up to 60 seconds total.
 *
 * Never throws — all RPC errors are caught mid-poll and only surfaced as a
 * STUCK status if the deadline expires.
 */
export async function watchTransaction(txHash: Hex): Promise<WatchResult> {
  const client = getPublicClient();
  const startedAt = Date.now();
  const deadline = startedAt + 60_000;
  const pollIntervalMs = 2_000;

  if (!client) {
    return {
      status: "STUCK",
      secondsPending: 0,
      revertReason: "No RPC URL configured",
    };
  }

  while (Date.now() < deadline) {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);

    try {
      const receipt: TransactionReceipt | null = await client
        .getTransactionReceipt({ hash: txHash })
        .catch(() => null);

      if (receipt) {
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
              await client.call({
                from: failedTx.from,
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

      if (!tx) {
        // Fully dropped from the mempool — gone
        return { status: "DROPPED", secondsPending: elapsed };
      }

      // Tx still pending in the mempool — keep waiting
    } catch {
      // RPC error mid-poll — do not abort, keep trying
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
 * Call OpenAI's chat API to produce a single plain-English explanation
 * sentence.  Falls back to the deterministic template if no API key is
 * configured or the request fails.
 *
 * Never throws — always returns a string.
 */
export async function explainPolicy(
  forecast: PSGForecast,
  policy: PolicyResult,
): Promise<string> {
  const apiKey = config.openaiApiKey;

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

  const systemPrompt =
    "Given this transaction risk data, write exactly one plain-English sentence explaining what is happening and why, using only the numbers provided. Do not invent numbers or claims not present in the input.";

  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Transaction risk data: ${JSON.stringify(payload)}`,
            },
          ],
          max_tokens: 120,
          temperature: 0,
        }),
      },
    );

    if (!response.ok) {
      return templateExplain(forecast, policy);
    }

    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body?.choices?.[0]?.message?.content?.trim();

    return text ?? templateExplain(forecast, policy);
  } catch {
    return templateExplain(forecast, policy);
  }
}
