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

// import simulateRouter from "./routes/simulate";
// import evaluateRouter from "./routes/evaluate";
// import statsRouter from "./routes/stats";
// import outcomeRouter from "./routes/outcome";
// import contentionRouter from "./routes/contention";
//
// app.use("/api/simulate", simulateRouter);
// app.use("/api/evaluate", evaluateRouter);
// app.use("/api/stats", statsRouter);
// app.use("/api/outcome", outcomeRouter);
// app.use("/api/contention", contentionRouter);

app.listen(PORT, () => {
  console.log(`Vantage backend listening on port ${PORT}`);
});

export {};