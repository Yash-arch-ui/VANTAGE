// Route test for GET /api/score/:address — real HTTP against the score router
// mounted on an ephemeral port, with a throwaway DB. Verifies the contract:
// scored 200, unscored 200 (a distinct answer, NOT an error), invalid 400.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PSGForecast } from "../psg/forecast.js";
import { initDatabase, recordEntry } from "../em/ledger.js";
import scoreRouter from "./score.js";

const FROM = "0x1111111111111111111111111111111111111111";
const CLEAN = "0x2222222222222222222222222222222222222222";
const NEVER = "0x3333333333333333333333333333333333333333";

function baseForecast(): PSGForecast {
  return {
    simulationSuccess: true,
    revertReason: null,
    simulatedOutput: "1",
    quotedOutput: null,
    outputDriftPercent: null,
    gasEstimate: "1",
    balanceSufficient: true,
    nonceCurrent: true,
    nonceIssue: null,
    contentionScore: null,
    riskLevel: "LOW",
    flags: [],
    timestamp: Date.now(),
  };
}

let server: Server;
let baseUrl: string;
let tmpDir: string;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vantage-score-route-"));
  initDatabase(join(tmpDir, "score.db"));

  // Clean history for the "scored" contract (5 clean evaluations).
  for (let i = 0; i < 5; i++) {
    recordEntry({
      txFrom: FROM,
      txTo: CLEAN,
      txData: "0x",
      txValue: "0",
      forecast: baseForecast(),
      policy: { action: "PROCEED", reason: "test" },
      explanation: "test",
    });
  }

  const app = express();
  app.use(express.json());
  app.use("/api", scoreRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server?.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("GET /api/score/:address", () => {
  it("returns 200 with a scored body for an evaluated contract", async () => {
    const res = await fetch(`${baseUrl}/api/score/${CLEAN}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { scored: boolean; score: number | null; breakdown: { sampleSize: number } };
    assert.equal(body.scored, true);
    assert.equal(body.score, 100);
    assert.equal(body.breakdown.sampleSize, 5);
  });

  it("returns 200 with a distinct unscored response (not an error) for an unevaluated contract", async () => {
    const res = await fetch(`${baseUrl}/api/score/${NEVER}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { scored: boolean; score: number | null; message?: string };
    assert.equal(body.scored, false);
    assert.equal(body.score, null);
    assert.match(body.message ?? "", /not yet scored/);
  });

  it("returns 400 for an invalid address", async () => {
    const res = await fetch(`${baseUrl}/api/score/not-an-address`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "ValidationError");
  });
});
