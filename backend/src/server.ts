import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { config } from "./config.js";
import { initDatabase } from "./em/ledger.js";

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
app.use("/api", evaluateRouter);
app.use("/api", outcomeRouter);
app.use("/api", statsRouter);

export { app };

// Only listen when run directly — a proof/test harness can import { app } and
// bind its own port without double-listening.
if (process.env.VANTAGE_NO_LISTEN !== "1") {
  app.listen(PORT, () => {
    console.log(`Vantage backend listening on port ${PORT}`);
  });
}
