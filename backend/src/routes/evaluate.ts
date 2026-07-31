import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { type VantageTxRequest, getPSGForecast } from "../psg/forecast.js";
import {
  decidePolicy,
  holdAndRecheck,
  explainPolicy,
  type PolicyResult,
} from "../apa/policy.js";
import { recordEntry } from "../em/ledger.js";

const router = Router();

// ── Request validation schema ──────────────────────────────────────────

const evaluateRequestBodySchema = z.object({
  tx: z.object({
    from: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "from must be a valid hex address"),
    to: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "to must be a valid hex address"),
    data: z.string().regex(/^0x[a-fA-F0-9]*$/i, "data must be a valid hex string"),
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
    const forecast = await getPSGForecast(tx, quotedOutput);

    let finalPolicy: PolicyResult;

    // 4. Run the policy decision
    const initialPolicy = decidePolicy(forecast);

    // 5. If the decision is HOLD_AND_RECHECK, let the polling loop resolve it
    if (initialPolicy.action === "HOLD_AND_RECHECK") {
      finalPolicy = await holdAndRecheck(tx, quotedOutput);
    } else {
      finalPolicy = initialPolicy;
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

    // 8. Return the combined result
    res.json({
      forecast,
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
