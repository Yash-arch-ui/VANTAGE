import express from "express";
import type { Server } from "node:http";
import cors from "cors";
import dotenv from "dotenv";
import { config } from "./config.js";
import { initDatabase } from "./em/ledger.js";
import { startWatchdog, WATCH_POLL_INTERVAL_MS } from "./services/watchdog.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4000;

app.use(cors({ origin: true }));
app.use(express.json());

// Execution Memory — open/create the SQLite ledger + calibration store before
// any request can touch it. Idempotent: existing rows are never wiped.
try {
  initDatabase(config.databasePath);
  console.log(`Execution Memory initialized at ${config.databasePath}`);
} catch (err) {
  console.error(
    "Execution Memory init failed — ledger/calibration will degrade gracefully:",
    err,
  );
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
