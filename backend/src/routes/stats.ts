import { Router } from "express";
import { getSessionStats } from "../em/ledger.js";

const router = Router();

// ── GET /stats ─────────────────────────────────────────────────────────

router.get("/stats", (_req, res) => {
  try {
    res.json(getSessionStats());
  } catch (err) {
    console.error("GET /stats — unexpected error:", err);
    res.status(500).json({
      error: "InternalServerError",
      message: "An unexpected error occurred while processing the request.",
    });
  }
});

export default router;
