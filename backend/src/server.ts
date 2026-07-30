import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4000;

app.use(cors({ origin: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "vantage-backend" });
});

import evaluateRouter from "./routes/evaluate.js";
app.use("/api", evaluateRouter);

app.listen(PORT, () => {
  console.log(`Vantage backend listening on port ${PORT}`);
});

export {};