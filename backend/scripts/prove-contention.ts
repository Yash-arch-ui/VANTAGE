// Prove the time-based contention window end-to-end on Monad testnet:
//
//   1. Fire a batch of strictly-sequential swaps (explicit nonce, each one
//      awaited before the next) so the AMM emits Swap events within the
//      window — no nonce races, unlike parallel sends.
//   2. Confirm getContentionScore crosses 0.7 (needs >= 14 Swap logs).
//   3. Confirm decidePolicy resolves to HOLD_AND_RECHECK.
//   4. Confirm holdAndRecheck() actually polls over multiple seconds before
//      resolving (it times out while contention stays elevated).
//
// Run from the vantage/ directory so config.ts picks up ../.env:
//   npx tsx backend/scripts/prove-contention.ts
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { config } from "../src/config.js";
import {
  MOCK_AMM_ADDRESS,
  mockAmmAbi,
  getContentionScore,
  getPSGForecast,
} from "../src/psg/forecast.js";
import { decidePolicy, holdAndRecheck } from "../src/apa/policy.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Contention threshold for HOLD_AND_RECHECK (see deriveRiskLevel).
const HIGH_CONTENTION_SCORE = 0.7;
// min(logs / 20, 1.0) — need at least 14 Swap logs to reach 0.7.
const MIN_SWAPS_FOR_0_7 = 14;
const BATCH_SWAPS = 24;
const SWAP_INPUT_AMOUNT = 1n * 10n ** 17n; // 0.1 token per swap

async function main() {
  const { privateKey, rpcUrl } = config;
  if (!privateKey) throw new Error("PRIVATE_KEY is not set in .env");
  const account = privateKeyToAccount(`0x${privateKey}`);

  const amm = MOCK_AMM_ADDRESS as Address;
  if (!amm) throw new Error("MockAMM address missing from contracts/deployments.json");

  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });

  // swap(minOutput, inputIsToken=true, inputAmount) with minOutput=0 — pulls
  // tokens via transferFrom, cannot revert on output price.
  const swapData = encodeFunctionData({
    abi: mockAmmAbi,
    functionName: "swap",
    args: [0n, true, SWAP_INPUT_AMOUNT],
  });

  console.log(`sender = ${account.address}`);
  console.log(`AMM    = ${amm}`);
  console.log(`batch  = ${BATCH_SWAPS} sequential swaps (${SWAP_INPUT_AMOUNT / 10n ** 17n} token each)`);
  console.log("");

  // ── 1. Strictly-sequential swap batch ─────────────────────────────────
  const startNonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  console.log(`start nonce = ${startNonce}`);

  let confirmed = 0;
  for (let i = 0; i < BATCH_SWAPS; i++) {
    const nonce = startNonce + i;
    try {
      const hash = await walletClient.sendTransaction({
        to: amm,
        data: swapData,
        nonce,
        gas: 500_000n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status === "success") {
        confirmed++;
        console.log(`  swap ${i + 1}/${BATCH_SWAPS} confirmed (nonce=${nonce}, block=${receipt.blockNumber})`);
      } else {
        console.error(`  swap ${i + 1}/${BATCH_SWAPS} REVERTED (nonce=${nonce})`);
      }
    } catch (err) {
      const e = err as { shortMessage?: string; message?: string };
      console.error(`  swap ${i + 1}/${BATCH_SWAPS} failed: ${e.shortMessage ?? e.message}`);
    }
  }

  console.log(`\nconfirmed ${confirmed}/${BATCH_SWAPS} swaps`);
  if (confirmed < MIN_SWAPS_FOR_0_7) {
    console.error(`Need >= ${MIN_SWAPS_FOR_0_7} confirmed swaps to reach 0.7.`);
    process.exitCode = 1;
    return;
  }

  // ── 2. Score the time-based window ────────────────────────────────────
  const score = await getContentionScore(amm);
  console.log(`\ncontentionScore (180s window) = ${score.toFixed(3)}`);
  if (score < HIGH_CONTENTION_SCORE) {
    console.error(`contentionScore did not cross ${HIGH_CONTENTION_SCORE}.`);
    process.exitCode = 1;
  }

  // ── 3. Full forecast + decision on a fresh swap tx ────────────────────
  const freshNonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const tx = { from: account.address, to: amm, data: swapData, value: 0n, nonce: freshNonce };

  const forecast = await getPSGForecast(tx);
  console.log(`\nforecast: contentionScore=${forecast.contentionScore?.toFixed(3)}, ` +
    `riskLevel=${forecast.riskLevel}, flags=${JSON.stringify(forecast.flags)}, nonceCurrent=${forecast.nonceCurrent}`);

  const initial = decidePolicy(forecast);
  console.log(`initial action = ${initial.action}`);
  console.log(`  reason: ${initial.reason}`);
  if (initial.action !== "HOLD_AND_RECHECK") {
    console.error("HOLD_AND_RECHECK did not trigger.");
    process.exitCode = 1;
  }

  // ── 4. holdAndRecheck — should visibly poll over multiple seconds ─────
  console.log(`\nholdAndRecheck() — interval 2s, timeout 14s ...`);
  const t0 = Date.now();
  const result = await holdAndRecheck(tx, undefined, { intervalMs: 2_000, timeoutMs: 14_000 });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`holdAndRecheck resolved in ${elapsed}s`);
  console.log(`final action = ${result.action}`);
  console.log(`  reason: ${result.reason}`);
  if (result.suggestedAdjustment) console.log(`  suggestedAdjustment: ${result.suggestedAdjustment}`);

  // ── 5. Visible re-samples — prove contention persists in the window ───
  console.log("\nvisible re-samples (score should stay elevated):");
  for (let s = 1; s <= 3; s++) {
    await sleep(3_000);
    const f = await getPSGForecast(tx);
    const a = decidePolicy(f);
    console.log(`  sample ${s}: score=${f.contentionScore?.toFixed(3)} risk=${f.riskLevel} action=${a.action}`);
  }

  const passed =
    score >= HIGH_CONTENTION_SCORE &&
    initial.action === "HOLD_AND_RECHECK" &&
    parseFloat(elapsed) >= 5;
  console.log(`\n${passed ? "✅ PASS" : "❌ FAIL"} — score=${score.toFixed(3)}, ` +
    `HOLD_AND_RECHECK=${initial.action}, holdAndRecheck elapsed=${elapsed}s`);
  if (!passed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});