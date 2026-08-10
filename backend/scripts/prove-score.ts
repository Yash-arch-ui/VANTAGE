// Live proof of the Vantage Score against the running backend + real chain.
//
//   1. Build a real clean history for ClaimContract — five real /api/evaluate
//      calls (claim slot 0..4, all unclaimed on-chain) → 5 clean PROCEED rows.
//   2. GET /api/score/ClaimContract  → a clean, well-sampled contract → 100.
//   3. GET /api/score/AMM    → the contract flagged with an active critical
//      failure_surge alert (prior audit) + warning + info alerts + 7/8 failed
//      evaluations in 24h → visibly lower score, breakdown explains why.
//   4. Also shows the score embedded in the /api/evaluate response.
//
// Requires the backend running on :4000 with the REAL vantage.db (the prior
// audit's AMM data is what the flagged half of the contrast reads).
//   cd backend && node_modules/.bin/tsx scripts/prove-score.ts
import "./_env.js";
import {
  createPublicClient,
  http,
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { config } from "../src/config.js";
import { CLAIM_CONTRACT_ADDRESS, AMM_ADDRESS, claimContractAbi } from "../src/psg/forecast.js";

const BASE_URL = "http://localhost:4000";
const ts = () => new Date().toISOString();

type ScoreBody = {
  scored: boolean;
  score: number | null;
  breakdown: { failureRate: number; alertCount: number; contentionStability: number; sampleSize: number };
  lastUpdated: string;
};

async function main(): Promise<void> {
  const { privateKey, rpcUrl } = config;
  const account = privateKeyToAccount(`0x${privateKey}`);
  const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const claim = CLAIM_CONTRACT_ADDRESS as Address;
  const amm = AMM_ADDRESS as Address;

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  VANTAGE SCORE LIVE PROOF — real ledger + alerts + chain");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  clean  contract = ClaimContract ${claim}`);
  console.log(`  flagged contract = AMM  ${amm}`);

  // ── 1. Build a real clean history on ClaimContract (5 real evaluations) ─
  console.log(`\n[${ts()}] building clean history: 5 real /api/evaluate calls (claim slot 0..4)…`);
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  for (let i = 0; i < 5; i++) {
    const data: Hex = encodeFunctionData({ abi: claimContractAbi, functionName: "claim", args: [BigInt(i)] });
    const res = await fetch(`${BASE_URL}/api/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tx: { from: account.address, to: claim, data, value: "0", nonce },
      }),
    });
    const body = (await res.json()) as {
      policy?: { action?: string };
      forecast?: { riskLevel?: string; score?: ScoreBody | null };
      entryId?: string | null;
    };
    console.log(
      `[${ts()}]   claim(${i}) → HTTP ${res.status} action=${body.policy?.action} risk=${body.forecast?.riskLevel} score=${body.forecast?.score?.score ?? "n/a"} (from /api/evaluate) entryId=${body.entryId?.slice(0, 8)}`,
    );
  }

  // ── 2. Score the clean contract ─────────────────────────────────────────
  console.log(`\n[${ts()}] GET /api/score/ClaimContract (clean history, sampleSize=5)…`);
  const clean = (await (await fetch(`${BASE_URL}/api/score/${claim}`)).json()) as ScoreBody;
  console.log(`[${ts()}] → ${JSON.stringify(clean, null, 2)}`);

  // ── 3. Score the flagged contract ──────────────────────────────────────
  console.log(`\n[${ts()}] GET /api/score/AMM (active critical failure_surge + 7/8 failed evals)…`);
  const flagged = (await (await fetch(`${BASE_URL}/api/score/${amm}`)).json()) as ScoreBody;
  console.log(`[${ts()}] → ${JSON.stringify(flagged, null, 2)}`);

  // ── 4. Verdict: the flagged contract must be visibly lower + explainable ─
  console.log("\n──────────────────────────────────────────────────────────────");
  const cleanScore = clean.scored ? clean.score ?? 0 : 0;
  const flaggedScore = flagged.scored ? flagged.score ?? 0 : 0;
  console.log(`  clean   = ${cleanScore}   flagged = ${flaggedScore}   (delta ${(cleanScore - flaggedScore).toFixed(1)} pts)`);
  console.log("  flagged breakdown → why:");
  if (flagged.scored) {
    const { failureRate, alertCount, contentionStability, sampleSize } = flagged.breakdown;
    console.log(`    failureRate ${(failureRate * 100).toFixed(1)}%    → −${(failureRate * 40).toFixed(1)} pts`);
    console.log(`    alertCount ${alertCount} (weighted) → −${Math.min(30, alertCount)} pts`);
    console.log(`    contentionStability ${contentionStability.toFixed(2)} → −${(contentionStability * 15).toFixed(1)} pts`);
    console.log(`    sampleSize ${sampleSize} (${sampleSize < 5 ? "< 5" : "≥ 5"}) → ${sampleSize < 5 ? "−15 pts" : "0 pts"}`);
  }
  const ok = flagged.scored && clean.scored && flaggedScore < cleanScore && cleanScore === 100;
  console.log(`\n  ${ok ? "✅ PROOF PASS — flagged contract scores meaningfully lower, breakdown explains it" : "❌ PROOF FAIL"}`);
  console.log("──────────────────────────────────────────────────────────────");
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
