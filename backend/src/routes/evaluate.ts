import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { type VantageTxRequest, getPSGForecast } from "../psg/forecast.js";
import {
  decidePolicy,
  holdAndRecheck,
  explainPolicy,
  applyWatchdogBias,
  type PolicyResult,
} from "../apa/policy.js";
import { recordEntry, addToWatchlist, getActiveCriticalAlertCount } from "../em/ledger.js";
import { computeScore } from "../services/scoring.js";

const router = Router();

// ── Request validation schema ──────────────────────────────────────────

const evaluateRequestBodySchema = z.object({
  tx: z.object({
    from: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "from must be a valid hex address"),
    to: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "to must be a valid hex address"),
    // Whole bytes only. Odd-length hex passed this check and then threw deep
    // inside viem, turning a plain client mistake into a 500.
    data: z
      .string()
      .regex(/^0x([a-fA-F0-9]{2})*$/i, "data must be a hex string of whole bytes"),
    value: z.string().regex(/^\d+$/, "value must be a non-negative integer string"),
    nonce: z.number().int().nonnegative("nonce must be a non-negative integer"),
  }),
  quotedOutput: z.string().regex(/^\d+$/, "quotedOutput must be a non-negative integer string").optional(),
});

// ── POST /evaluate ─────────────────────────────────────────────────────

router.post("/evaluate", async (req: Request, res: Response) => {
  try {
    // 1. Validate request body
    const parsed = evaluateRequestBodySchema.safeParse(req.body);

    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      res.status(400).json({
        error: "ValidationError",
        message: firstError?.message ?? "Invalid request body",
        details: parsed.error.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }

    const { tx: rawTx, quotedOutput: quotedOutputStr } = parsed.data;

    // 2. Parse fields into their TypeScript types
    const tx: VantageTxRequest = {
      from: rawTx.from as `0x${string}`,
      to: rawTx.to as `0x${string}`,
      data: rawTx.data as `0x${string}`,
      value: BigInt(rawTx.value),
      nonce: rawTx.nonce,
    };

    let quotedOutput: bigint | undefined;
    if (quotedOutputStr !== undefined) {
      try {
        quotedOutput = BigInt(quotedOutputStr);
      } catch {
        res.status(400).json({
          error: "ValidationError",
          message: `quotedOutput "${quotedOutputStr}" is not a valid integer.`,
        });
        return;
      }
    }

    // 3. Run the full PSG forecast
    let forecast = await getPSGForecast(tx, quotedOutput);

    let finalPolicy: PolicyResult;

    // 4. Run the policy decision
    const initialPolicy = decidePolicy(forecast);

    // 5. If the decision is HOLD_AND_RECHECK, let the polling loop resolve it.
    //    The hold re-forecasts internally, so adopt the forecast its decision
    //    was actually based on — otherwise a hold that clears returns PROCEED
    //    next to the stale HIGH-contention evidence that caused the hold, and
    //    that contradiction is what gets written to the immutable audit row.
    if (initialPolicy.action === "HOLD_AND_RECHECK") {
      const held = await holdAndRecheck(tx, quotedOutput);
      finalPolicy = held.policy;
      if (held.forecast) forecast = held.forecast;
    } else {
      finalPolicy = initialPolicy;
    }

    // 5b. Watchdog (APA) — if the target contract has active undismissed
    //     critical alerts, bias the finalized decision toward caution and
    //     record a flag, so a known on-chain problem can't be papered over by
    //     a clean simulation. The reason carries the alert count (flags[]
    //     pattern lives on the forecast; the bias lives on the policy).
    const activeCriticalAlerts = getActiveCriticalAlertCount(tx.to);
    if (activeCriticalAlerts > 0) {
      finalPolicy = applyWatchdogBias(finalPolicy, activeCriticalAlerts);
      forecast.flags.push("WATCHDOG_CRITICAL_ALERTS");
    }

    // 6. Generate a human-readable explanation
    const explanation = await explainPolicy(forecast, finalPolicy);

    // 7. Persist an immutable audit record (Execution Memory) before returning.
    //    The frontend uses entryId later to report the tx outcome via /api/outcome.
    const entryId = recordEntry({
      txFrom: tx.from,
      txTo: tx.to,
      txData: tx.data,
      txValue: tx.value.toString(),
      forecast,
      policy: finalPolicy,
      explanation,
    });

    // 7b. Watchdog — auto-watch: every contract that gets successfully
    //     evaluated is watched automatically (INSERT OR IGNORE — idempotent,
    //     never duplicates an existing entry, never fails the evaluate).
    addToWatchlist(tx.to, "auto");

    // 7c. Vantage Score — a live 0-100 trust score for the target contract,
    //     attached to the forecast so the judge sees it beside the risk output.
    //     The contention input is the forecast's own score this request already
    //     computed — never a re-scan of the chain; the rest is pure aggregation
    //     over the execution-memory tables the request already lives next to.
    //     Runs after recordEntry so the score reflects this very evaluation.
    const score = computeScore(tx.to, forecast.contentionScore);

    // 8. Return the combined result
    res.json({
      forecast: { ...forecast, score },
      policy: finalPolicy,
      explanation,
      entryId, // null when the ledger was unavailable — policy result still returned
    });
  } catch (err) {
    console.error("POST /evaluate — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

export default router;
