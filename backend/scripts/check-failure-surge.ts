// CHECK 3 — failure_surge alert type, end-to-end against the LIVE server.
//
// Fires a burst of swaps that are guaranteed to REVERT on-chain (minOutput set
// to 10x what the pool can actually give — the Test A/B pattern). Each swap is
// run through the real pipeline:
//   a. POST /api/evaluate  → PSG simulates the revert → CRITICAL → ABORT (ledger row)
//   b. real on-chain submission → status "reverted"
//   c. POST /api/outcome   → outcome=FAILED attached to the ledger row
// The watchdog's NEXT real poll cycle reads this ledger window and must raise
// failure_surge. Nothing here calls pollContract/compareSnapshots directly.
import "./_env.js";
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
import { MOCK_AMM_ADDRESS, mockAmmAbi } from "../src/psg/forecast.js";

const BASE_URL = "http://localhost:4000";
const SWAP_INPUT_AMOUNT = 1n * 10n ** 17n; // 0.1 token per swap
const REVERTS = 7; // at least 6, per the check
const GAS_LIMIT = 500_000n;
const ts = () => new Date().toISOString();

async function nextNonce(
  client: ReturnType<typeof createPublicClient>,
  sender: Address,
  lastNonce: number,
): Promise<number> {
  const pending = await client.getTransactionCount({ address: sender, blockTag: "pending" });
  return pending > lastNonce + 1 ? pending : lastNonce + 1;
}

function encodeSwap(minOutput: bigint): Hex {
  return encodeFunctionData({
    abi: mockAmmAbi,
    functionName: "swap",
    args: [minOutput, true, SWAP_INPUT_AMOUNT],
  });
}

async function main(): Promise<void> {
  const { privateKey, rpcUrl } = config;
  if (!privateKey) throw new Error("PRIVATE_KEY not set");
  const account = privateKeyToAccount(`0x${privateKey}`);
  const amm = MOCK_AMM_ADDRESS as Address;
  if (!amm) throw new Error("MockAMM address missing");

  const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });

  console.log(`[${ts()}] sender=${account.address} AMM=${amm}`);

  const balance = await client.readContract({
    address: "0x4832448eC5578b84c7b13E3EeBA2370Ccfbd5579" as Address,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`[${ts()}] MockERC20 balance = ${balance.toString()}`);

  const expected = (await client.readContract({
    address: amm, abi: mockAmmAbi, functionName: "getExpectedOutput", args: [SWAP_INPUT_AMOUNT, true],
  })) as bigint;
  const minOutput = expected * 10n; // 10x → guaranteed InsufficientOutputAmount revert
  const data = encodeSwap(minOutput);
  console.log(`[${ts()}] getExpectedOutput(0.1 token)=${expected} → minOutput=${minOutput} (10x) — every swap MUST revert`);

  let lastNonce = -1;
  let abortRows = 0, failedRows = 0;

  for (let i = 1; i <= REVERTS; i++) {
    const nonce = await nextNonce(client, account.address, lastNonce);
    lastNonce = nonce;

    // a) REAL evaluate against the running server
    const evalRes = await fetch(`${BASE_URL}/api/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx: { from: account.address, to: amm, data, value: "0", nonce } }),
    });
    const evalJson = (await evalRes.json()) as {
      policy?: { action?: string; reason?: string };
      forecast?: { riskLevel?: string; revertReason?: string | null };
      entryId?: string | null;
    };
    const entryId = evalJson.entryId;
    console.log(
      `[${ts()}] [${i}/${REVERTS}] evaluate → HTTP ${evalRes.status} action=${evalJson.policy?.action} risk=${evalJson.forecast?.riskLevel} revert="${evalJson.forecast?.revertReason}" entryId=${entryId ? entryId.slice(0, 8) : "null"}`,
    );
    if (evalJson.policy?.action === "ABORT") abortRows++;
    if (!entryId) throw new Error(`evaluate returned no entryId on iteration ${i}`);

    // b) REAL on-chain reverting submission
    const hash = await wallet.sendTransaction({ to: amm, data, nonce, gas: GAS_LIMIT });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    console.log(`[${ts()}] [${i}/${REVERTS}] on-chain ${hash.slice(0, 14)}… status=${receipt.status} block=${receipt.blockNumber}`);
    if (receipt.status !== "reverted") console.log(`  ⚠ expected reverted, got ${receipt.status}`);

    // c) REAL outcome report
    const outRes = await fetch(`${BASE_URL}/api/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId, userAction: "SIGNED", outcome: "FAILED", txHash: hash }),
    });
    const outJson = (await outRes.json()) as { ok?: boolean };
    console.log(`[${ts()}] [${i}/${REVERTS}] outcome → HTTP ${outRes.status} ok=${outJson.ok}`);
    if (outJson.ok) failedRows++;
  }

  console.log(`\n[${ts()}] burst done — ABORT ledger rows: ${abortRows}, FAILED outcomes recorded: ${failedRows}`);
  console.log(`[${ts()}] now waiting for the REAL watchdog poll cycle to raise failure_surge (NOT manually invoked)…`);
}

main().catch((e) => { console.error(e); process.exit(1); });
