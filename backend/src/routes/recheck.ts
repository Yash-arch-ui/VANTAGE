import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getAddress, type Hex } from "viem";
import { getEntryById, getActiveCriticalAlertCount } from "../em/ledger.js";
import { getPSGForecast, getPublicClient } from "../psg/forecast.js";
import { decidePolicy, applyWatchdogBias } from "../apa/policy.js";

const router = Router();

// ── Request validation schema ──────────────────────────────────────────

const recheckBodySchema = z.object({
  entryId: z.string().uuid({ message: "entryId must be a valid UUID" }),
});

// ── POST /recheck ──────────────────────────────────────────────────────
//
// Re-verify an already-evaluated transaction against fresh chain state. The
// Guard console polls this in the background after the initial /evaluate, so a
// pool move (or any other state change) between evaluation and sign shows up
// as a live STALE_STATE verdict without the user re-submitting anything.
//
// The whole recheck is backend-owned and re-uses the existing pipeline:
// getPSGForecast (same drift math, same thresholds) → decidePolicy (same risk
// policy) → applyWatchdogBias. Nothing here duplicates the drift algorithm,
// and the ledger row is only read, never written — this is a re-verification,
// not a new audit event.
//
// The nonce is re-read from the mempool so the validity check describes the
// current state, not the one at evaluate time. The original quotedOutput is
// preserved from the entry's forecast_json, because drift is always measured
// against the price the user was originally quoted.

router.post("/recheck", async (req: Request, res: Response) => {
  try {
    const parsed = recheckBodySchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "ValidationError",
        message: parsed.error.errors[0]?.message ?? "Invalid request body",
        details: parsed.error.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }

    const { entryId } = parsed.data;

    const entry = getEntryById(entryId);
    if (!entry) {
      res.status(404).json({
        error: "NotFound",
        message: `No ledger entry with id "${entryId}"`,
      });
      return;
    }

    const { tx_from: from, tx_to: to, tx_data: data } = entry;
    if (!from || !to || !data) {
      res.status(422).json({
        error: "UnprocessableEntity",
        message: "Ledger entry has no usable transaction payload to re-check.",
      });
      return;
    }

    // The ledger stores addresses lowercased, but the simulation pipeline's
    // known-contract lookup is keyed by the EIP-55 checksummed address. Normalize
    // so a recheck of a AMM entry takes the same path as the original
    // evaluate — otherwise it falls into the generic raw-call branch, which
    // cannot decode the swap and reports a phantom "Call returned no data".
    const txFrom = getAddress(from);
    const txTo = getAddress(to);

    const client = getPublicClient();
    const nonce = client
      ? await client.getTransactionCount({ address: txFrom, blockTag: "pending" })
      : 0;

    // The "before" side of the drift comparison — the quote the user was shown.
    let quotedOutput: bigint | undefined;
    try {
      const saved = JSON.parse(entry.forecast_json) as { quotedOutput?: string | null };
      if (typeof saved.quotedOutput === "string") {
        quotedOutput = BigInt(saved.quotedOutput);
      }
    } catch {
      // Unparseable or absent — drift simply stays null, same as a fresh eval
      // without a quoted output (claim/approve presets).
    }

    const forecast = await getPSGForecast(
      {
        from: txFrom,
        to: txTo,
        data: data as Hex,
        value: BigInt(entry.tx_value ?? "0"),
        nonce,
      },
      quotedOutput,
    );

    // Same decision pipeline as /evaluate (minus the HOLD_AND_RECHECK polling
    // loop — this returns the fresh decision as-is; a high-contention recheck
    // simply reports "Holding" without spawning a server-side wait).
    let policy = decidePolicy(forecast);
    const activeCriticalAlerts = getActiveCriticalAlertCount(txTo);
    if (activeCriticalAlerts > 0) {
      policy = applyWatchdogBias(policy, activeCriticalAlerts);
      forecast.flags.push("WATCHDOG_CRITICAL_ALERTS");
    }

    res.json({
      entryId,
      recheckedAt: Date.now(),
      forecast: {
        outputDriftPercent: forecast.outputDriftPercent,
        flags: forecast.flags,
        riskLevel: forecast.riskLevel,
        contentionScore: forecast.contentionScore,
        // ECA — the fresh conflict verdict rides the recheck payload so a
        // client polling for drift also sees conflict state change. Additive;
        // existing fields are untouched.
        conflictScore: forecast.conflictScore ?? null,
        simulationSuccess: forecast.simulationSuccess,
        revertReason: forecast.revertReason,
        simulatedOutput: forecast.simulatedOutput,
      },
      policy: { action: policy.action, reason: policy.reason },
    });
  } catch (err) {
    console.error("POST /recheck — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

export default router;
