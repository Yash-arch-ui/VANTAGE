import "./_env.js"; // MUST be first: loads .env before anything reads process.env
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseAbi,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { config } from "../src/config.js";
import {
  MOCK_AMM_ADDRESS,
  MOCK_CLAIM_ADDRESS,
  mockAmmAbi,
  mockClaimAbi,
  getContentionScore,
} from "../src/psg/forecast.js";

/**
 * Re-verifies every Guard-console scenario against the LIVE stack after the
 * Lightfall background change (which touches nothing in the backend — this is
 * a regression gate, per the "re-verify everything" requirement).
 *
 * Runs against a running backend (POST /api/evaluate) + live Monad testnet.
 *
 * Operational order: the contention scenarios run FIRST while the 180s
 * window is still hot (fewer on-chain sends needed), then a cooldown waits
 * the window out, then the clean scenarios run. Each scenario records its
 * canonical label; the summary prints in the canonical order.
 *
 *   cd backend && set -a && . ./.env && set +a && npx tsx scripts/reverify-guard.ts
 */

const API = "http://localhost:4000/api/evaluate";
const ERC20 = "0x4832448eC5578b84c7b13E3EeBA2370Ccfbd5579" as Address;
const AMM = MOCK_AMM_ADDRESS as Address;
const CLAIM = MOCK_CLAIM_ADDRESS as Address;

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);

const swapData = (minOutput: bigint, inputAmount = 1n * 10n ** 18n): Hex =>
  encodeFunctionData({ abi: mockAmmAbi, functionName: "swap", args: [minOutput, true, inputAmount] });
const claimData = (slot: bigint): Hex =>
  encodeFunctionData({ abi: mockClaimAbi, functionName: "claim", args: [slot] });
const approveData = (amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AMM, amount] });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Outcome = { scenario: string; expected: string; actual: string; pass: boolean; note?: string };
const results = new Map<string, Outcome>();

function record(
  scenario: string,
  expected: string,
  actual: string,
  pass: boolean,
  note?: string,
): void {
  results.set(scenario, { scenario, expected, actual, pass, note });
  const mark = pass ? "✅ PASS" : "❌ FAIL";
  console.log(`  ${mark} ${scenario}\n      expected: ${expected}\n      actual:   ${actual}${note ? `\n      note:     ${note}` : ""}`);
}

type EvalResult = {
  forecast: {
    riskLevel: string;
    flags: string[];
    revertReason: string | null;
    outputDriftPercent: number | null;
    contentionScore: number | null;
  };
  policy: { action: string; reason: string };
};

async function evaluateTx(args: {
  to: Address;
  data: Hex;
  nonce: number;
  quotedOutput?: bigint;
  from?: Address;
}): Promise<EvalResult> {
  const body = {
    tx: {
      from: args.from ?? account.address,
      to: args.to,
      data: args.data,
      value: "0",
      nonce: args.nonce,
    },
    ...(args.quotedOutput !== undefined ? { quotedOutput: args.quotedOutput.toString() } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const resp = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return (await resp.json()) as EvalResult;
  } finally {
    clearTimeout(timer);
  }
}

const { privateKey, rpcUrl } = config;
if (!privateKey) throw new Error("PRIVATE_KEY is not set in .env");
const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, "")}`);

const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const walletClient = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });

async function pendingNonce(): Promise<number> {
  return publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
}

async function sendRaw(to: Address, data: Hex, gas = 500_000n): Promise<boolean> {
  try {
    const nonce = await pendingNonce();
    const hash = await walletClient.sendTransaction({ to, data, nonce, gas });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return receipt.status === "success";
  } catch (e) {
    console.warn(`  ⚠️ send failed (${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message})`);
    return false;
  }
}

function fmtFlags(flags: string[]): string {
  return flags.length ? flags.join(",") : "(none)";
}

/** A clean verdict may still carry the watchdog's critical-alert annotation. */
function isCleanAnnotated(flags: string[]): boolean {
  return flags.every((f) => f === "WATCHDOG_CRITICAL_ALERTS");
}

async function main(): Promise<void> {
  console.log(`sender    = ${account.address}`);
  console.log(`AMM       = ${AMM}`);
  console.log(`MockClaim = ${CLAIM}`);
  console.log(`MockERC20 = ${ERC20}`);
  console.log("");

  const quote = async (amount = 1n * 10n ** 18n) =>
    (await publicClient.readContract({
      address: AMM,
      abi: mockAmmAbi,
      functionName: "getExpectedOutput",
      args: [amount, true],
    })) as bigint;

  // ── Phase A: contention scenarios, while the 180s window is still hot ────
  console.log("── S9 Swap contention warn (hot window) ───────────────────────");
  try {
    let contention = await getContentionScore(AMM);
    let added = 0;
    if (contention < 0.3) {
      const add = Math.min(Math.ceil((0.3 - contention) * 20), 7);
      for (let i = 0; i < add && (await sendRaw(AMM, swapData(0n, 10n ** 17n), 300_000n)); i++) added++;
      contention = await getContentionScore(AMM);
    }
    const r = await evaluateTx({ to: AMM, data: swapData(0n), nonce: await pendingNonce() });
    const pass = r.forecast.flags.includes("HIGH_CONTENTION") && r.policy.action === "WARN";
    record(
      "S9 Swap contention warn",
      "WARN + HIGH_CONTENTION (MEDIUM, score in [0.3, 0.7))",
      `action=${r.policy.action} risk=${r.forecast.riskLevel} flags=[${fmtFlags(r.forecast.flags)}] contention=${contention.toFixed(3)} (added ${added} swaps)`,
      pass,
      !pass ? r.policy.reason : undefined,
    );
  } catch (e) {
    record("S9 Swap contention warn", "WARN", `threw: ${(e as Error).message}`, false);
  }

  console.log("\n── S10 Swap contention timeout (hot window) ───────────────────");
  try {
    let contention = await getContentionScore(AMM);
    let added = 0;
    if (contention < 0.7) {
      const add = Math.min(Math.ceil((0.7 - contention) * 20), 8);
      for (let i = 0; i < add && (await sendRaw(AMM, swapData(0n, 10n ** 17n), 300_000n)); i++) added++;
      contention = await getContentionScore(AMM);
    }
    const t0 = Date.now();
    const r = await evaluateTx({ to: AMM, data: swapData(0n), nonce: await pendingNonce() });
    const elapsed = (Date.now() - t0) / 1000;
    const pass = r.policy.action === "SUGGEST_ADJUSTMENT" && elapsed >= 15 && contention >= 0.7;
    record(
      "S10 Swap contention timeout",
      "HOLD_AND_RECHECK → SUGGEST_ADJUSTMENT after ~30s hold",
      `action=${r.policy.action} risk=${r.forecast.riskLevel} flags=[${fmtFlags(r.forecast.flags)}] contention=${contention.toFixed(3)} holdElapsed=${elapsed.toFixed(1)}s (added ${added} swaps)`,
      pass,
      !pass ? r.policy.reason : undefined,
    );
  } catch (e) {
    record("S10 Swap contention timeout", "SUGGEST_ADJUSTMENT", `threw: ${(e as Error).message}`, false);
  }

  // ── Phase B: wait the 180s windows out, then run the clean scenarios ─────
  console.log("\n── cooldown: waiting for contention windows to calm ────────────");
  const coolStart = Date.now();
  while (Date.now() - coolStart < 240_000) {
    const [a, e] = await Promise.all([getContentionScore(AMM), getContentionScore(ERC20)]);
    if (a < 0.3 && e < 0.3) break;
    console.log(`  cooling: AMM=${a.toFixed(2)} ERC20=${e.toFixed(2)} — waiting…`);
    await sleep(15_000);
  }
  console.log(`  windows calm (${(((Date.now() - coolStart) / 1000)).toFixed(0)}s)`);

  // ── Setup: balance + allowance for token-input swaps ────────────────────
  let balance = (await publicClient.readContract({
    address: ERC20,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  if (balance === 0n) {
    console.log("  minting test tokens (MockERC20 is mint-anyone on testnet)…");
    await sendRaw(
      ERC20,
      encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [account.address, 10_000n * 10n ** 18n] }),
      200_000n,
    );
    balance = 10_000n * 10n ** 18n;
  }
  const allowance = (await publicClient.readContract({
    address: ERC20,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, AMM],
  })) as bigint;
  if (allowance < 2n * 10n ** 18n) {
    console.log("  topping up MockAMM allowance…");
    await sendRaw(ERC20, approveData(maxUint256), 200_000n);
  }
  console.log(`  token balance=${balance.toString()}`);

  // ── S1. Swap on MockAMM — clean ─────────────────────────────────────────
  console.log("\n── S1 Swap clean ──────────────────────────────────────────────");
  try {
    const q = await quote();
    const r = await evaluateTx({ to: AMM, data: swapData(0n), nonce: await pendingNonce(), quotedOutput: q });
    const flags = r.forecast.flags;
    const pass =
      r.forecast.riskLevel === "LOW" &&
      (r.policy.action === "PROCEED" || (r.policy.action === "WARN" && isCleanAnnotated(flags)));
    record(
      "S1 Swap clean",
      "PROCEED, LOW, no risk flags (watchdog-annotated WARN still counts as clean)",
      `action=${r.policy.action} risk=${r.forecast.riskLevel} flags=[${fmtFlags(flags)}] contention=${r.forecast.contentionScore?.toFixed(3)}`,
      pass,
      r.policy.action !== "PROCEED" ? r.policy.reason : undefined,
    );
  } catch (e) {
    record("S1 Swap clean", "PROCEED", `threw: ${(e as Error).message}`, false);
  }

  // ── S2. Swap — nonce-stale ──────────────────────────────────────────────
  console.log("\n── S2 Swap nonce-stale ────────────────────────────────────────");
  try {
    const r = await evaluateTx({ to: AMM, data: swapData(0n), nonce: 0 });
    record(
      "S2 Swap nonce-stale",
      "ABORT + NONCE_STALE",
      `action=${r.policy.action} risk=${r.forecast.riskLevel} flags=[${fmtFlags(r.forecast.flags)}]`,
      r.policy.action === "ABORT" && r.forecast.flags.includes("NONCE_STALE"),
    );
  } catch (e) {
    record("S2 Swap nonce-stale", "ABORT", `threw: ${(e as Error).message}`, false);
  }

  // ── S3. Swap — revert-abort ─────────────────────────────────────────────
  console.log("\n── S3 Swap revert-abort ───────────────────────────────────────");
  try {
    const q = await quote();
    const r = await evaluateTx({ to: AMM, data: swapData(q * 10n), nonce: await pendingNonce(), quotedOutput: q });
    record(
      "S3 Swap revert-abort",
      "ABORT + REVERT (InsufficientOutputAmount)",
      `action=${r.policy.action} risk=${r.forecast.riskLevel} flags=[${fmtFlags(r.forecast.flags)}] revert=${r.forecast.revertReason}`,
      r.policy.action === "ABORT" &&
        r.forecast.flags.includes("REVERT") &&
        (r.forecast.revertReason ?? "").includes("InsufficientOutputAmount"),
    );
  } catch (e) {
    record("S3 Swap revert-abort", "ABORT", `threw: ${(e as Error).message}`, false);
  }

  // ── S4. Swap — drift (reserve manipulation) ─────────────────────────────
  console.log("\n── S4 Swap drift ──────────────────────────────────────────────");
  try {
    const [t, m] = (await publicClient.readContract({
      address: AMM,
      abi: mockAmmAbi,
      functionName: "getReserves",
    })) as [bigint, bigint];
    const oldQuote = await quote();
    await sendRaw(
      AMM,
      encodeFunctionData({ abi: mockAmmAbi, functionName: "manipulateReserves", args: [(t * 112n) / 100n, m] }),
      200_000n,
    );
    const r = await evaluateTx({ to: AMM, data: swapData(0n), nonce: await pendingNonce(), quotedOutput: oldQuote });
    await sendRaw(
      AMM,
      encodeFunctionData({ abi: mockAmmAbi, functionName: "manipulateReserves", args: [t, m] }),
      200_000n,
    ); // restore
    record(
      "S4 Swap drift",
      "WARN + STALE_STATE (drift < -5%)",
      `action=${r.policy.action} risk=${r.forecast.riskLevel} flags=[${fmtFlags(r.forecast.flags)}] drift=${r.forecast.outputDriftPercent?.toFixed(2)}%`,
      r.policy.action === "WARN" && r.forecast.flags.includes("STALE_STATE"),
    );
  } catch (e) {
    record("S4 Swap drift", "WARN", `threw: ${(e as Error).message}`, false);
  }

  // ── S5/S6. Claim a slot — clean, then conflict ──────────────────────────
  console.log("\n── S5/S6 Claim a slot ─────────────────────────────────────────");
  try {
    let slot: bigint | null = null;
    for (let i = 0; i < 10; i++) {
      const claimed = (await publicClient.readContract({
        address: CLAIM,
        abi: mockClaimAbi,
        functionName: "isClaimed",
        args: [BigInt(i)],
      })) as boolean;
      if (!claimed) {
        slot = BigInt(i);
        break;
      }
    }
    if (slot === null) {
      record("S5 Claim clean", "PROCEED (unclaimed slot)", "all 10 slots already claimed on testnet", false, "nothing left to claim");
    } else {
      const r = await evaluateTx({ to: CLAIM, data: claimData(slot), nonce: await pendingNonce() });
      const pass =
        r.forecast.riskLevel === "LOW" &&
        (r.policy.action === "PROCEED" || (r.policy.action === "WARN" && isCleanAnnotated(r.forecast.flags)));
      record(
        "S5 Claim clean",
        "PROCEED, LOW (watchdog-annotated WARN still counts as clean)",
        `action=${r.policy.action} risk=${r.forecast.riskLevel} flags=[${fmtFlags(r.forecast.flags)}] slot=${slot}`,
        pass,
        r.policy.action !== "PROCEED" ? r.policy.reason : undefined,
      );

      await sendRaw(CLAIM, claimData(slot), 300_000n);
      const r2 = await evaluateTx({ to: CLAIM, data: claimData(slot), nonce: await pendingNonce() });
      record(
        "S6 Claim conflict",
        "ABORT + REVERT (SlotAlreadyClaimed)",
        `action=${r2.policy.action} risk=${r2.forecast.riskLevel} flags=[${fmtFlags(r2.forecast.flags)}] revert=${r2.forecast.revertReason}`,
        r2.policy.action === "ABORT" &&
          r2.forecast.flags.includes("REVERT") &&
          (r2.forecast.revertReason ?? "").includes("SlotAlreadyClaimed"),
      );
    }
  } catch (e) {
    record("S5/S6 Claim", "PROCEED / ABORT", `threw: ${(e as Error).message}`, false);
  }

  // ── S7/S8. Unlimited approval — clean, then exposure flag ───────────────
  console.log("\n── S7/S8 Unlimited approval ───────────────────────────────────");
  try {
    const clean = await evaluateTx({ to: ERC20, data: approveData(1n), nonce: await pendingNonce() });
    const pass =
      clean.forecast.riskLevel === "LOW" &&
      !clean.forecast.flags.includes("APPROVAL_EXPOSURE") &&
      (clean.policy.action === "PROCEED" ||
        (clean.policy.action === "WARN" && isCleanAnnotated(clean.forecast.flags)));
    record(
      "S7 Approve clean",
      "PROCEED, LOW, no APPROVAL_EXPOSURE",
      `action=${clean.policy.action} risk=${clean.forecast.riskLevel} flags=[${fmtFlags(clean.forecast.flags)}]`,
      pass,
      !pass ? clean.policy.reason : undefined,
    );

    const exposure = await evaluateTx({ to: ERC20, data: approveData(maxUint256), nonce: await pendingNonce() });
    record(
      "S8 Approve exposure flag",
      "WARN + APPROVAL_EXPOSURE (MEDIUM)",
      `action=${exposure.policy.action} risk=${exposure.forecast.riskLevel} flags=[${fmtFlags(exposure.forecast.flags)}]`,
      exposure.policy.action === "WARN" && exposure.forecast.flags.includes("APPROVAL_EXPOSURE"),
    );
  } catch (e) {
    record("S7/S8 Approve", "PROCEED / WARN", `threw: ${(e as Error).message}`, false);
  }

  // ── Summary (canonical order) ───────────────────────────────────────────
  const canonical = [
    "S1 Swap clean",
    "S4 Swap drift",
    "S9 Swap contention warn",
    "S10 Swap contention timeout",
    "S2 Swap nonce-stale",
    "S3 Swap revert-abort",
    "S5 Claim clean",
    "S6 Claim conflict",
    "S7 Approve clean",
    "S8 Approve exposure flag",
  ];
  const passed = canonical.filter((name) => results.get(name)?.pass).length;
  console.log(`\n=== SUMMARY: ${passed}/${canonical.length} scenarios PASS ===`);
  for (const name of canonical) {
    const r = results.get(name);
    console.log(`  ${r?.pass ? "PASS" : "FAIL"}  ${name}${r?.note ? ` — ${r.note}` : ""}`);
  }
  if (passed !== canonical.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
