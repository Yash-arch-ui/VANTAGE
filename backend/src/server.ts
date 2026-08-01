import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import cors from "cors";
import dotenv from "dotenv";
import { config } from "./config.js";
import { initDatabase } from "./em/ledger.js";
import { startWatchdog, WATCH_POLL_INTERVAL_MS } from "./services/watchdog.js";

dotenv.config();

const app = express();

/**
 * A non-numeric PORT (an empty string, a stray space, a typo) used to parse to
 * NaN, and `listen(NaN)` silently binds a random ephemeral port — the log then
 * claims "listening on port NaN" while every health check against the expected
 * port fails.
 */
function resolvePort(raw: string | undefined): number {
  if (raw === undefined) return 4000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    console.error(`Invalid PORT "${raw}" — falling back to 4000.`);
    return 4000;
  }
  return parsed;
}

const PORT = resolvePort(process.env.PORT);

app.use(cors({ origin: true }));
app.use(express.json());

// Execution Memory — open/create the SQLite ledger + calibration store before
// any request can touch it. Idempotent: existing rows are never wiped.
//
// This is fatal, not degradable. Without the ledger the service cannot record
// an evaluation, hand back an entryId, score a contract or feed the watchdog —
// it answers 200 on every route while silently storing nothing, which is worse
// than being down because a health check still passes. Exit so the deploy fails
// visibly instead. (The watchdog below is genuinely optional and does degrade.)
try {
  initDatabase(config.databasePath);
  console.log(`Execution Memory initialized at ${config.databasePath}`);
} catch (err) {
  console.error(`FATAL: Execution Memory init failed at "${config.databasePath}":`, err);
  process.exit(1);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "vantage-backend" });
});

import evaluateRouter from "./routes/evaluate.js";
import outcomeRouter from "./routes/outcome.js";
import statsRouter from "./routes/stats.js";
import watchlistRouter from "./routes/watchlist.js";
import scoreRouter from "./routes/score.js";
import ledgerRouter from "./routes/ledger.js";
import watchRouter from "./routes/watch.js";
app.use("/api", evaluateRouter);
app.use("/api", outcomeRouter);
app.use("/api", statsRouter);
app.use("/api", watchlistRouter);
app.use("/api", scoreRouter);
app.use("/api", ledgerRouter);
app.use("/api", watchRouter);

// Unknown /api path. Express's default is an HTML "Cannot GET /api/foo", which
// a JSON client parses as garbage rather than surfacing a useful message.
app.use("/api", (_req, res) => {
  res.status(404).json({
    error: "NotFound",
    message: "No such endpoint.",
  });
});

// Terminal error handler.
//
// Every route body has its own try/catch, so this exists for the errors raised
// *before* a handler runs — chiefly express.json() rejecting a malformed body.
// Without it express replies with HTML (and a stack trace outside production),
// and the frontend's res.json() throws a parse error instead of reporting what
// went wrong. The four-argument signature is what marks this as error
// middleware to express; `next` is unused but must stay.
app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  // Body-parser tags its own failures, which are client errors, not ours.
  if (err.type === "entity.parse.failed" || err.status === 400) {
    res.status(400).json({
      error: "ValidationError",
      message: "Request body is not valid JSON.",
      details: [],
    });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(err.status ?? 500).json({
    error: "InternalServerError",
    message: "An unexpected error occurred while processing the request.",
  });
});

export { app };

// Only listen when run directly — a proof/test harness can import { app } and
// bind its own port without double-listening.
if (process.env.VANTAGE_NO_LISTEN !== "1") {
  app.listen(PORT, () => {
    console.log(`Vantage backend listening on port ${PORT}`);
    // Watchdog — background polling loop. Started only after the HTTP server
    // is listening (spec order), never before. A start failure must not take
    // the server down: the app stays up, it just won't monitor contracts.
    try {
      startWatchdog();
      console.log(`[watchdog] started — polling every ${WATCH_POLL_INTERVAL_MS / 1000}s`);
    } catch (err) {
      console.error("[watchdog] failed to start — continuing without it:", err);
    }
  });
}
