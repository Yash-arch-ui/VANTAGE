import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  getAlerts,
  updateAlert,
  getAlertSummary,
} from "../em/ledger.js";

const router = Router();

// ── Validation schemas ──────────────────────────────────────────────────

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const watchlistBodySchema = z.object({
  address: z.string().regex(ADDRESS_RE, "address must be a valid hex address"),
  watchType: z.enum(["manual", "auto"]).optional(),
});

const alertsQuerySchema = z.object({
  unread: z.string().regex(/^(true|false)$/i, "unread must be true or false").optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  address: z.string().regex(ADDRESS_RE, "address must be a valid hex address").optional(),
  limit: z.string().regex(/^\d+$/, "limit must be a positive integer").optional(),
});

const alertPatchSchema = z
  .object({
    read: z.boolean().optional(),
    dismissed: z.boolean().optional(),
  })
  .refine((v) => v.read !== undefined || v.dismissed !== undefined, {
    message: "at least one of read or dismissed must be provided",
  });

function validationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: "ValidationError",
    message: error.errors[0]?.message ?? "Invalid request",
    details: error.errors.map((e) => ({ path: e.path.join("."), message: e.message })),
  });
}

// ── POST /api/watchlist ────────────────────────────────────────────────

router.post("/watchlist", (req: Request, res: Response) => {
  try {
    const parsed = watchlistBodySchema.safeParse(req.body);
    if (!parsed.success) {
      validationError(res, parsed.error);
      return;
    }
    const { address, watchType } = parsed.data;
    const added = addToWatchlist(address, watchType ?? "manual");
    const items = getWatchlist();
    res.status(201).json({ ok: true, address, watchType: watchType ?? "manual", added, items });
  } catch (err) {
    console.error("POST /watchlist — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

// ── DELETE /api/watchlist/:address ─────────────────────────────────────

router.delete("/watchlist/:address", (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!ADDRESS_RE.test(address)) {
      res.status(400).json({
        error: "ValidationError",
        message: "address must be a valid hex address",
        details: [],
      });
      return;
    }
    const removed = removeFromWatchlist(address);
    res.json({ ok: true, address, removed });
  } catch (err) {
    console.error("DELETE /watchlist — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

// ── GET /api/watchlist ─────────────────────────────────────────────────

router.get("/watchlist", (_req: Request, res: Response) => {
  try {
    res.json({ items: getWatchlist() });
  } catch (err) {
    console.error("GET /watchlist — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

// ── GET /api/alerts ────────────────────────────────────────────────────

router.get("/alerts", (req: Request, res: Response) => {
  try {
    const parsed = alertsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      validationError(res, parsed.error);
      return;
    }
    const { unread, severity, address, limit } = parsed.data;
    res.json({
      items: getAlerts({
        unread: unread === undefined ? undefined : unread.toLowerCase() === "true",
        severity,
        address,
        limit: limit === undefined ? undefined : parseInt(limit, 10),
      }),
    });
  } catch (err) {
    console.error("GET /alerts — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

// ── PATCH /api/alerts/:id ──────────────────────────────────────────────

router.patch("/alerts/:id", (req: Request, res: Response) => {
  try {
    const parsed = alertPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      validationError(res, parsed.error);
      return;
    }
    const { read, dismissed } = parsed.data;
    const updated = updateAlert(req.params.id, {
      read,
      dismissed,
    });
    if (!updated) {
      res.status(404).json({
        error: "NotFound",
        message: `No alert with id "${req.params.id}"`,
      });
      return;
    }
    res.json({ ok: true, id: req.params.id, read: read ?? null, dismissed: dismissed ?? null });
  } catch (err) {
    console.error("PATCH /alerts — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

// ── GET /api/alerts/summary ────────────────────────────────────────────

router.get("/alerts/summary", (_req: Request, res: Response) => {
  try {
    res.json(getAlertSummary());
  } catch (err) {
    console.error("GET /alerts/summary — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

export default router;
