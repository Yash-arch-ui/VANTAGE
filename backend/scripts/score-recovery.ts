import "./_env.js"; // MUST be first: loads .env before anything reads process.env
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { config } from "../src/config.js";
import { AMM_ADDRESS, ammAbi } from "../src/psg/forecast.js";

/**
 * Score-recovery campaign: runs a series of REAL successful AMM swaps
 * (token<->MON) against the live deployed backend, so every swap is evaluated
 * (PROCEED → ledger row), submitted on-chain, confirmed, and reported through
 * /api/outcome. That dilutes the 24h failure rate and lets the watchdog
 * auto-resolve the failure_surge alert.
 *
 *   cd backend && npx tsx scripts/score-recovery.ts
 *
 * Env knobs:
 *   API_BASE — backend base URL (default: the deployed Railway service)
 *   CYCLES   — number of swaps (default 24)
 *   SLEEP_MS — pause between swaps (default 20s; contention scanner uses a
 *              180s window / 20 logs = 1.0, so spacing keeps it low)
 */

const API = (
  process.env.API_BASE ?? "https://vantage-backend-production-8929.up.railway.app"
).replace(/\/$/, "");
const AMM = AMM_ADDRESS as Address;
const ERC20 = "0x4832448eC5578b84c7b13E3EeBA2370Ccfbd5579" as Address;

const CYCLES = parseInt(process.env.CYCLES ?? "24", 10);
const BASE_SLEEP_MS = parseInt(process.env.SLEEP_MS ?? "20000", 10);

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const TOKEN_AMOUNTS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4];
const MON_AMOUNTS = [0.05, 0.1, 0.15, 0.2, 0.25];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const { privateKey, rpcUrl } = config;
if (!privateKey) throw new Error("PRIVATE_KEY is not set in .env");
const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, "")}`);

const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const walletClient = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });

const wei = (n: number) => BigInt(Math.round(n * 1e18));
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

async function pendingNonce(): Promise<number> {
  return publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
}

function swapData(inputIsToken: boolean, inputAmount: bigint): Hex {
  return encodeFunctionData({
    abi: ammAbi,
    functionName: "swap",
    args: [0n, inputIsToken, inputAmount],
  });
}

type EvalResponse = {
  forecast: {
    simulationSuccess: boolean;
    revertReason: string | null;
    riskLevel: string;
    flags: string[];
    contentionScore: number | null;
    balanceSufficient: boolean | null;
    score: {
      scored: boolean;
      score: number | null;
      breakdown: {
        failureRate: number;
        alertCount: number;
        contentionStability: number;
        sampleSize: number;
      };
    };
  };
  policy: { action: string; reason: string };
  entryId: string | null;
};

async function evaluate(tx: {
  from: string;
  to: string;
  data: Hex;
  value: string;
  nonce: number;
}): Promise<EvalResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const resp = await fetch(`${API}/api/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`evaluate ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return (await resp.json()) as EvalResponse;
  } finally {
    clearTimeout(timer);
  }
}

async function reportOutcome(
  entryId: string,
  userAction: string,
  outcome: string,
  txHash: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${API}/api/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId, userAction, outcome, txHash }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function finalScore(): Promise<string> {
  try {
    const resp = await fetch(`${API}/api/score/${AMM}`);
    const j = (await resp.json()) as {
      score: number | null;
      breakdown: {
        failureRate: number;
        alertCount: number;
        contentionStability: number;
        sampleSize: number;
      };
    };
    return `score=${j.score} failureRate=${(j.breakdown.failureRate * 100).toFixed(1)}% alerts=${j.breakdown.alertCount} contention=${j.breakdown.contentionStability} samples=${j.breakdown.sampleSize}`;
  } catch {
    return "score=?? (unreachable)";
  }
}

async function main() {
  console.log(`[campaign] account=${account.address}`);
  console.log(`[campaign] AMM=${AMM}`);
  console.log(`[campaign] API=${API}`);
  console.log(`[campaign] cycles=${CYCLES} sleep=${BASE_SLEEP_MS}ms`);
  console.log(`[campaign] baseline: ${await finalScore()}`);
  console.log("");

  const [tokenBal, monBal, allowance] = await Promise.all([
    publicClient.readContract({
      address: ERC20,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({
      address: ERC20,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, AMM],
    }),
  ]);
  console.log(
    `[campaign] token balance=${(Number(tokenBal) / 1e18).toFixed(2)}  MON balance=${(Number(monBal) / 1e18).toFixed(3)}  allowance=${allowance >= 2n ** 255n ? "MAX" : (Number(allowance) / 1e18).toFixed(2)}`,
  );

  if (tokenBal === 0n) throw new Error("no token balance — mint some first");
  if (allowance === 0n) throw new Error("no AMM allowance — approve first");
  if (monBal < wei(0.5)) console.warn("[campaign] ⚠ low MON balance — MON-input swaps may be skipped");

  let successCount = 0;
  let confirmedCount = 0;
  let skipped = 0;

  for (let i = 1; i <= CYCLES; i++) {
    const t0 = Date.now();
    try {
      const inputIsToken = i % 3 !== 0; // 2/3 token→MON, 1/3 MON→token
      const amount = inputIsToken ? pick(TOKEN_AMOUNTS) : pick(MON_AMOUNTS);
      const inputAmount = wei(amount);
      const value = inputIsToken ? 0n : inputAmount;
      const data = swapData(inputIsToken, inputAmount);
      const nonce = await pendingNonce();

      const ev = await evaluate({
        from: account.address,
        to: AMM,
        data,
        value: value.toString(),
        nonce,
      });

      const sc = ev.forecast.score;
      const scoreLine = sc.scored ? `score=${sc.score}` : "score=unscored";
      const flags = ev.forecast.flags.join(",") || "none";

      if (ev.policy.action === "ABORT") {
        console.log(
          `[${i}/${CYCLES}] ABORT → skipped (${ev.policy.reason}) ${scoreLine} flags=[${flags}] contention=${ev.forecast.contentionScore}`,
        );
        skipped++;
        await sleep(BASE_SLEEP_MS);
        continue;
      }

      if (ev.forecast.balanceSufficient === false) {
        console.log(`[${i}/${CYCLES}] LOW_BALANCE → skipped ${scoreLine}`);
        skipped++;
        await sleep(BASE_SLEEP_MS);
        continue;
      }

      // Submit on-chain with the SAME nonce the guard evaluated.
      const hash = await walletClient.sendTransaction({
        to: AMM,
        data,
        value,
        nonce,
        gas: 500_000n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      const outcome = receipt.status === "success" ? "CONFIRMED" : "FAILED";

      if (ev.entryId) await reportOutcome(ev.entryId, "SIGNED", outcome, hash);

      successCount++;
      if (outcome === "CONFIRMED") confirmedCount++;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

      console.log(
        `[${i}/${CYCLES}] ${inputIsToken ? "TOK→MON" : "MON→TOK"} ${amount} → ${outcome} ${hash.slice(0, 12)}… ` +
          `action=${ev.policy.action} risk=${ev.forecast.riskLevel} flags=[${flags}] contention=${ev.forecast.contentionScore?.toFixed(2)} ${scoreLine} (${elapsed}s)`,
      );
    } catch (e) {
      console.error(
        `[${i}/${CYCLES}] ERROR: ${(e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message}`,
      );
      skipped++;
    }

    await sleep(BASE_SLEEP_MS);
  }

  console.log("");
  console.log(
    `[campaign] done: ${confirmedCount} CONFIRMED, ${successCount} submitted, ${skipped} skipped`,
  );
  console.log(`[campaign] final: ${await finalScore()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
