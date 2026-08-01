import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Hex } from "viem";
import { classifyTx } from "../apa/policy.js";

const router = Router();

const paramsSchema = z.object({
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "txHash must be a 32-byte hex hash"),
});

const querySchema = z.object({
  // Epoch milliseconds. The client knows when it broadcast; a stateless
  // request otherwise has no way to tell a 2-second-old tx from a 2-minute-old
  // one, which is exactly the distinction between "propagating" and "stuck".
  since: z.string().regex(/^\d+$/, "since must be epoch milliseconds").optional(),
});

// ── GET /api/watch/:txHash ─────────────────────────────────────────────

/**
 * One-shot status classification for a submitted transaction. Returns
 * immediately; the client polls (~2s) rather than the server blocking.
 *
 * The point of this endpoint is disambiguating states that all look identical
 * to naive polling (a null receipt): still propagating, genuinely stuck, or
 * actually dropped.
 */
router.get("/watch/:txHash", async (req: Request, res: Response) => {
  try {
    const params = paramsSchema.safeParse(req.params);
    const query = querySchema.safeParse(req.query);
    if (!params.success || !query.success) {
      const errors = [
        ...(params.success ? [] : params.error.errors),
        ...(query.success ? [] : query.error.errors),
      ];
      res.status(400).json({
        error: "ValidationError",
        message: errors[0]?.message ?? "Invalid request",
        details: errors.map((e) => ({ path: e.path.join("."), message: e.message })),
      });
      return;
    }

    const since = query.data.since !== undefined ? Number(query.data.since) : undefined;
    const report = await classifyTx(params.data.txHash as Hex, since);
    res.json(report);
  } catch (err) {
    console.error("GET /watch — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while checking the transaction.",
    });
  }
});

export default router;
