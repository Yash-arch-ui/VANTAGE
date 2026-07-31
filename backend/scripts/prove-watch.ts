// Live proof of watchTransaction() against real transactions on Monad testnet.
//
//   Scenario 1 — submit a real swap that WILL confirm (minOutput derived from
//                getExpectedOutput with a 10% buffer) → expect CONFIRMED, and
//                show it actually polling (per-iteration timestamps) rather
//                than resolving on the first check.
//   Scenario 2 — submit a swap that WILL revert (minOutput 10x what the pool
//                can give), bypassing PSG on purpose → expect FAILED with a
//                real decoded revertReason from the block-pinned re-execution.
//   Scenario 3 — informational: demonstrate that a genuine STUCK/DROPPED tx
//                cannot be forced deterministically on this RPC. Low gas is
//                rejected outright ("Transaction fee too low"); a nonce-gapped
//                tx is not surfaced by eth_getTransactionByHash, so
//                watchTransaction reports DROPPED even though the tx is still
//                in the pool and mines once the gap is filled.
//
// Run from the backend/ directory with the .env loaded:
//   cd backend && set -a && . ../.env && set +a && node_modules/.bin/tsx scripts/prove-watch.ts
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { config } from "../src/config.js";
import { MOCK_AMM_ADDRESS, mockAmmAbi } from "../src/psg/forecast.js";
import {
  watchTransaction,
  type WatchPoll,
  type WatchResult,
} from "../src/apa/policy.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Swap parameters ────────────────────────────────────────────────────

const SWAP_INPUT_AMOUNT = 1n * 10n ** 17n; // 0.1 token per swap
const GAS_LIMIT = 500_000n;
const WATCH_POLL_MS = 1_000; // fast enough to observe several real polls before the ~1s Monad block lands

const ts = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

function logIteration(p: WatchPoll): void {
  const flags = [
    p.hasReceipt ? "receipt=FOUND" : `receipt=none txKnown=${p.txKnown}`,
    p.error ? `error=${p.error}` : null,
  ].filter(Boolean);
  console.log(`    [${ts()}] poll #${p.iteration} elapsed=${(p.elapsedMs / 1000).toFixed(1)}s ${flags.join(" ")}`);
}

function summarize(label: string, result: WatchResult, startedAt: number, iterations: number): void {
  const wall = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`    → ${label}: status=${result.status}, secondsPending=${result.secondsPending}s, pollIterations=${iterations}, wallTime=${wall}s`);
  if (result.revertReason !== undefined) {
    console.log(`    → revertReason: ${result.revertReason ?? "null"}`);
  }
}

/**
 * Next nonce for a new submission. The Monad RPC's pending view can lag a
 * just-mined tx (it returned the same nonce for a tx that was still in
 * flight, causing "An existing transaction had higher priority" on resubmit),
 * so never go backwards from the nonce we last used.
 */
async function nextNonce(
  client: ReturnType<typeof createPublicClient>,
  sender: Address,
  lastNonce: number,
): Promise<number> {
  const pending = await client.getTransactionCount({ address: sender, blockTag: "pending" });
  return pending > lastNonce + 1 ? pending : lastNonce + 1;
}

async function getExpectedOutput(client: ReturnType<typeof createPublicClient>, amm: Address): Promise<bigint> {
  return client.readContract({
    address: amm,
    abi: mockAmmAbi,
    functionName: "getExpectedOutput",
    args: [SWAP_INPUT_AMOUNT, true],
  });
}

function encodeSwap(minOutput: bigint): Hex {
  return encodeFunctionData({
    abi: mockAmmAbi,
    functionName: "swap",
    args: [minOutput, true, SWAP_INPUT_AMOUNT],
  });
}

async function scenarioConfirmed(
  client: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  sender: Address,
  amm: Address,
): Promise<{ ok: boolean; nonce: number }> {
  console.log("\n=== Scenario 1: successful swap → expect CONFIRMED ===");

  const nonce = await nextNonce(client, sender, -1);
  const expected = await getExpectedOutput(client, amm);
  const minOutput = (expected * 90n) / 100n; // 10% slippage buffer → will succeed
  console.log(`  getExpectedOutput(0.1 token) = ${expected} wei → minOutput=${minOutput} (90%)`);

  const hash = await wallet.sendTransaction({
    to: amm,
    data: encodeSwap(minOutput),
    nonce,
    gas: GAS_LIMIT,
  });
  console.log(`  submitted ${hash} nonce=${nonce} at ${ts()} — calling watchTransaction immediately`);

  let iterations = 0;
  const t0 = Date.now();
  const result = await watchTransaction(hash, {
    pollIntervalMs: WATCH_POLL_MS,
    onIteration: (p) => { iterations++; logIteration(p); },
  });

  summarize("scenario 1", result, t0, iterations);
  if (result.status !== "CONFIRMED") {
    console.error("  ✗ expected CONFIRMED");
    return { ok: false, nonce };
  }
  console.log(`  ✓ CONFIRMED — mined ${result.secondsPending}s after the first poll started (${iterations} poll iteration(s))`);
  return { ok: true, nonce };
}

async function scenarioFailed(
  client: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  sender: Address,
  amm: Address,
  lastNonce: number,
): Promise<{ ok: boolean; nonce: number }> {
  console.log("\n=== Scenario 2: swap that WILL revert → expect FAILED + decoded revertReason ===");

  const nonce = await nextNonce(client, sender, lastNonce);
  const expected = await getExpectedOutput(client, amm);
  const minOutput = expected * 10n; // 10x what the pool can give → guaranteed revert
  console.log(`  getExpectedOutput(0.1 token) = ${expected} wei → minOutput=${minOutput} (10x) → must revert on-chain`);

  // Deliberately bypass PSG — submit the reverting tx raw.
  const hash = await wallet.sendTransaction({
    to: amm,
    data: encodeSwap(minOutput),
    nonce,
    gas: GAS_LIMIT,
  });
  console.log(`  submitted ${hash} nonce=${nonce} at ${ts()}`);

  let iterations = 0;
  const t0 = Date.now();
  const result = await watchTransaction(hash, {
    pollIntervalMs: WATCH_POLL_MS,
    onIteration: (p) => { iterations++; logIteration(p); },
  });

  summarize("scenario 2", result, t0, iterations);
  if (result.status !== "FAILED") {
    console.error(`  ✗ expected FAILED, got ${result.status}`);
    return { ok: false, nonce };
  }
  const reason = result.revertReason ?? "null";
  console.log(`  revertReason = "${reason}"`);
  const realReason = typeof reason === "string" && reason.startsWith("InsufficientOutputAmount(expected=");
  if (!realReason) {
    console.error("  ✗ expected a decoded InsufficientOutputAmount(...) reason, not null/generic");
    return { ok: false, nonce };
  }
  console.log("  ✓ FAILED with a real decoded revertReason extracted from the block-pinned re-execution");
  return { ok: true, nonce };
}

// Informational — a genuine STUCK/DROPPED tx cannot be forced deterministically
// on this RPC. Returns "INFO" and is excluded from the PASS/FAIL verdict.
async function scenarioStuckOrDropped(
  client: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  sender: Address,
  amm: Address,
  lastNonce: number,
): Promise<"INFO"> {
  console.log("\n=== Scenario 3: forcing STUCK / DROPPED (informational) ===");
  console.log("  Not counted in PASS/FAIL — a real stuck/dropped tx is hard to force on this RPC:");
  console.log("    • Very low gas price is rejected outright (\"Transaction fee too low\") — never enters the pool.");
  console.log("    • Normal txs mine in ~1-2s (Monad blocks are ~0.3s), so there is no natural stuck window.");
  console.log("    • A nonce-gapped tx is accepted, but eth_getTransactionByHash does NOT return it while the");
  console.log("      gap exists → watchTransaction never observes it as pending, keeps polling through the 10s");
  console.log("      never-visible grace, then reports DROPPED. The tx is actually still in the pool and mines once");
  console.log("      the gap is filled — so that DROPPED is an RPC-visibility artifact. Proving it:");

  const nonce = await nextNonce(client, sender, lastNonce);
  const gapNonce = nonce + 1; // leave `nonce` empty so `gapNonce` cannot be mined yet
  console.log(`  submitting a swap with nonce=${gapNonce} while nonce ${nonce} stays empty`);

  let hash: Hex;
  try {
    hash = await wallet.sendTransaction({
      to: amm,
      data: encodeSwap(0n),
      nonce: gapNonce,
      gas: GAS_LIMIT,
    });
  } catch (err) {
    const e = err as { shortMessage?: string };
    console.log(`  could not submit (${e.shortMessage ?? "send failed"}) — skipping scenario 3; this is why forced stuck/dropped is not reliably triggerable on demand.`);
    return "INFO";
  }
  console.log(`  submitted ${hash} at ${ts()}`);

  let iterations = 0;
  const t0 = Date.now();
  const result = await watchTransaction(hash, {
    pollIntervalMs: WATCH_POLL_MS,
    timeoutMs: 15_000,
    onIteration: (p) => { iterations++; logIteration(p); },
  });
  summarize("scenario 3", result, t0, iterations);
  console.log(`  → watchTransaction reported ${result.status} after ${result.secondsPending}s (${iterations} poll iteration(s))`);

  // Fill the gap: if the 'dropped' tx still mines afterward, it was never really evicted.
  console.log(`  filling the gap (nonce ${nonce}) and watching the '${result.status}' tx...`);
  try {
    const fillHash = await wallet.sendTransaction({
      to: amm,
      data: encodeSwap(0n),
      nonce,
      gas: GAS_LIMIT,
    });
    const fillReceipt = await client.waitForTransactionReceipt({ hash: fillHash, timeout: 60_000 });
    console.log(`  gap-filler (nonce ${nonce}) confirmed in block ${fillReceipt.blockNumber}`);
    const stuckReceipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    console.log(`  → the '${result.status}' tx mined in block ${stuckReceipt.blockNumber} (status=${stuckReceipt.status}) — it was never truly evicted`);
  } catch {
    console.log("  → could not complete the gap-fill check (insufficient balance or eviction).");
  }

  console.log("  conclusion: a deterministic STUCK/DROPPED cannot be forced on this RPC, so this scenario is");
  console.log("  reported as evidence of the limitation rather than as an assertion.");
  return "INFO";
}

async function main(): Promise<void> {
  const { privateKey, rpcUrl } = config;
  if (!privateKey) throw new Error("PRIVATE_KEY is not set in .env");
  const account = privateKeyToAccount(`0x${privateKey}`);

  const amm = MOCK_AMM_ADDRESS as Address;
  if (!amm) throw new Error("MockAMM address missing from contracts/deployments.json");

  const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });

  console.log(`sender = ${account.address}`);
  console.log(`AMM    = ${amm}`);
  console.log(`chain  = Monad testnet (${rpcUrl})`);

  const s1 = await scenarioConfirmed(client, wallet, account.address, amm);
  const s2 = await scenarioFailed(client, wallet, account.address, amm, s1.nonce);
  const s3 = await scenarioStuckOrDropped(client, wallet, account.address, amm, s2.nonce);

  const results = [s1.ok ? "PASS" : "FAIL", s2.ok ? "PASS" : "FAIL", s3];

  const passed = s1.ok && s2.ok;
  console.log(`\n${passed ? "✅ SCENARIOS 1-2 PASS" : "❌ SOME FAILED"} — scenario results: [${results.join(", ")}]`);
  if (!passed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
