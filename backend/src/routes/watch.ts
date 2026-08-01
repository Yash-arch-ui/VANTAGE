import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Hex } from "viem";
import { classifyTx } from "../apa/policy.js";

const router = Router();

const paramsSchema = z.object({
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "txHash must be a 32-byte hex hash"),
});

/**
 * A transaction older than this is not something this endpoint can reason
 * about — the mempool window is long past, and any answer would be guesswork.
 */
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Tolerance for a client whose clock runs slightly fast. */
const MAX_CLOCK_SKEW_MS = 60_000;

const querySchema = z.object({
  // Epoch milliseconds, required. The client knows when it broadcast; a
  // stateless request otherwise has no way to tell a 2-second-old tx from a
  // 2-minute-old one, which is exactly the distinction between "propagating"
  // and "stuck". Defaulting it to now makes elapsed time permanently zero and
  // silently renders both DROPPED and STUCK unreachable.
  since: z.string().regex(/^\d+$/, "since must be epoch milliseconds"),
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

    // `since` drives every elapsed-time decision, so an out-of-range value is
    // not a harmless input: since=0 makes a one-second-old transaction look
    // hours old and returns "DROPPED — resubmit it", which would have the user
    // broadcast a duplicate of a transaction that is still perfectly alive.
    const since = Number(query.data.since);
    const now = Date.now();
    if (!Number.isSafeInteger(since) || since > now + MAX_CLOCK_SKEW_MS || since < now - MAX_AGE_MS) {
      res.status(400).json({
        error: "ValidationError",
        message: `since must be a timestamp within the last ${MAX_AGE_MS / 3_600_000} hours and not in the future`,
        details: [{ path: "since", message: "timestamp out of range" }],
      });
      return;
    }

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
