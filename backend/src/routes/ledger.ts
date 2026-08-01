import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getRecentEntries } from "../em/ledger.js";

const router = Router();

// Query params arrive as strings. limit/offset are validated here only for
// shape — the clamping to a sane page size lives in getRecentEntries so every
// caller of that function gets the same guarantee.
const querySchema = z.object({
  limit: z.string().regex(/^\d+$/, "limit must be a positive integer").optional(),
  offset: z.string().regex(/^\d+$/, "offset must be a non-negative integer").optional(),
  contract: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "contract must be a valid hex address")
    .optional(),
});

// ── GET /api/ledger ────────────────────────────────────────────────────

/**
 * Newest-first page of recorded decisions — the audit trail behind "Vantage
 * caught N risky transactions". Optionally scoped to one contract.
 *
 * The stored forecast blob is not returned; only its riskLevel is projected
 * out, so a long timeline stays cheap to fetch.
 */
router.get("/ledger", (req: Request, res: Response) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "ValidationError",
        message: parsed.error.errors[0]?.message ?? "Invalid query parameters",
        details: parsed.error.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }

    const { limit, offset, contract } = parsed.data;
    const { items, total } = getRecentEntries({
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
      contract,
    });

    res.json({ items, total });
  } catch (err) {
    console.error("GET /ledger — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while reading the ledger.",
    });
  }
});

export default router;
