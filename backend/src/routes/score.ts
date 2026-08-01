import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { computeScore } from "../services/scoring.js";

const router = Router();

const addressSchema = z.string().regex(
  /^0x[a-fA-F0-9]{40}$/,
  "address must be a valid hex address",
);

// ── GET /api/score/:address ────────────────────────────────────────────

/**
 * Live 0-100 Vantage Score for one contract. A contract that has never been
 * evaluated returns 200 with `scored: false` ("not yet scored") — that is a
 * legitimate, distinct answer, not an error.
 */
router.get("/score/:address", (req: Request, res: Response) => {
  try {
    const parsed = addressSchema.safeParse(req.params.address);
    if (!parsed.success) {
      res.status(400).json({
        error: "ValidationError",
        message: parsed.error.errors[0]?.message ?? "Invalid address",
        details: parsed.error.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }
    res.json(computeScore(parsed.data));
  } catch (err) {
    console.error("GET /score — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while computing the score.",
    });
  }
});

export default router;
