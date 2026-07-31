import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { updateOutcome, getEntryById } from "../em/ledger.js";
import { recalibrate } from "../em/calibrator.js";

const router = Router();

// ── Request validation schema ──────────────────────────────────────────

const outcomeBodySchema = z.object({
  entryId: z.string().uuid({ message: "entryId must be a valid UUID" }),
  userAction: z.enum(["SIGNED", "CANCELLED", "OVERRIDDEN"], {
    message: "userAction must be SIGNED, CANCELLED or OVERRIDDEN",
  }),
  outcome: z
    .enum(["CONFIRMED", "FAILED", "DROPPED", "STUCK"])
    .optional(),
  txHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, "txHash must be a 0x-prefixed 64-char hex string")
    .optional(),
});

// ── POST /outcome ──────────────────────────────────────────────────────

router.post("/outcome", (req: Request, res: Response) => {
  try {
    const parsed = outcomeBodySchema.safeParse(req.body);

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

    const { entryId, userAction, outcome, txHash } = parsed.data;

    // The entry must exist before we attach an outcome to it.
    const entry = getEntryById(entryId);
    if (!entry) {
      res.status(404).json({
        error: "NotFound",
        message: `No ledger entry with id "${entryId}"`,
      });
      return;
    }

    updateOutcome(entryId, userAction, outcome ?? null, txHash ?? null);

    // Adapt this contract's contention threshold from its real history.
    recalibrate(entry.tx_to);

    res.json({ ok: true, entryId, userAction, outcome: outcome ?? null, txHash: txHash ?? null });
  } catch (err) {
    console.error("POST /outcome — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

export default router;
