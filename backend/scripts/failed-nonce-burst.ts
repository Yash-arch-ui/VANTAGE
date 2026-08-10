// Broadcast a burst of FAILED transactions plus a pile of HIGH-NONCE
// (nonce-gapped) transactions against the demo contracts, so the watchdog /
// contention scanner has a real spike to observe.
//
//   Phase A — 21 guaranteed-REVERT transactions with sequential nonces.
//             Each one mines as status 0 (failed) and drives block density
//             on the AMM and ClaimContract contracts.
//   Phase B — 10 high-nonce transactions whose nonces leave permanent gaps
//             (nonce = current + 30 + i*2). They can never be mined until the
//             gap fills, so they sit in the mempool as "block contention".
//   Phase C — 20 successful swaps to pump event-log density so the contention
//             scanner's 3-minute log window actually reads HIGH (reverts emit
//             no logs, so A and B alone never move the score).
//
// Run from backend/:  npx tsx scripts/failed-nonce-burst.ts
// Select phases with PHASE=ABC (default) | A | B | C | AB | AC | BC.
import "./_env.js"; // MUST be first: loads .env before config.ts (via forecast.js) evaluates
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { getContentionScore } from "../src/psg/forecast.js";

const rpcUrl = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) throw new Error("PRIVATE_KEY is not set — copy .env.example to .env");
const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, "")}`);

// Same addresses as deployments.json / contention-spike.ts.
const AMM = "0x7567C23BE5CB52F3B270562180776A95f1bbCa8e" as `0x${string}`;
const CLAIM = "0x1712beC5cD3F8F7a47CB0dD322f9DC9209423df4" as `0x${string}`;

const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });

const abi = parseAbi([
  "function addLiquidity(uint256 tokenAmount) payable",
  "function swap(uint256 minOutput, bool inputIsToken, uint256 inputAmount) payable",
  "function claim(uint256 slotId)",
]);

// Deterministic revert calldata — each reverts no matter what state the pool is in:
//  - addLiquidity(0) with no value            -> InvalidLiquidityAmounts()
//  - swap(minOutput=2^255, token-input, 0)    -> InsufficientOutputAmount(2^255, actual)
//  - claim(11)                                -> InvalidSlot() (TOTAL_SLOTS = 10)
const revertCalls: { to: `0x${string}`; data: `0x${string}` }[] = [
  { to: AMM, data: encodeFunctionData({ abi, functionName: "addLiquidity", args: [0n] }) },
  { to: AMM, data: encodeFunctionData({ abi, functionName: "swap", args: [2n ** 255n, true, 0n] }) },
  { to: CLAIM, data: encodeFunctionData({ abi, functionName: "claim", args: [11n] }) },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phase = process.env.PHASE ?? "ABC";

async function broadcast(tx: Parameters<typeof wallet.sendTransaction>[0], attempt = 1): Promise<`0x${string}`> {
  try {
    return await wallet.sendTransaction(tx);
  } catch (e) {
    if (attempt >= 3) throw e;
    await sleep(1000 * attempt);
    return broadcast(tx, attempt + 1);
  }
}

// Successful swap calldata: token->MON swaps of 20e18 tokens (minOutput 0).
const swapInToken = encodeFunctionData({ abi, functionName: "swap", args: [0n, true, 20n * 10n ** 18n] });
const swapInMon = encodeFunctionData({ abi, functionName: "swap", args: [0n, false, 0n] });

async function phaseA(startNonce: number) {
  const phaseASize = 21;
  const hashes: `0x${string}`[] = [];
  for (let i = 0; i < phaseASize; i++) {
    const { to, data } = revertCalls[i % revertCalls.length];
    try {
      const hash = await broadcast({ to, data, nonce: startNonce + i, gas: 200000n });
      hashes.push(hash);
      console.log(`[A ${i + 1}/${phaseASize}] broadcast revert tx ${hash} (nonce ${startNonce + i})`);
    } catch (e: unknown) {
      console.error(
        `[A ${i + 1}/${phaseASize}] broadcast failed:`,
        (e as { shortMessage?: string }).shortMessage ?? (e as Error).message,
      );
    }
    await sleep(250);
  }

  let minedFailed = 0;
  let minedSuccess = 0;
  let dropped = 0;
  for (const hash of hashes) {
    try {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status === "reverted") minedFailed++;
      else minedSuccess++;
    } catch {
      dropped++;
    }
  }
  console.log(
    `Phase A result: broadcast ${hashes.length}, mined-reverted ${minedFailed}, mined-success ${minedSuccess}, dropped ${dropped}`,
  );
}

async function phaseB(startNonce: number) {
  const gapBase = startNonce + 30;
  let gapSent = 0;
  for (let i = 0; i < 10; i++) {
    const nonce = gapBase + i * 2; // permanent gap: nothing fills nonce+1
    try {
      const hash = await broadcast({
        to: AMM,
        data: revertCalls[1].data, // would revert if ever mined
        nonce,
        gas: 200000n,
      });
      gapSent++;
      console.log(`[B ${i + 1}/10] high-nonce tx nonce=${nonce} ${hash} (left pending)`);
    } catch (e: unknown) {
      console.error(
        `[B ${i + 1}/10] high-nonce broadcast failed:`,
        (e as { shortMessage?: string }).shortMessage ?? (e as Error).message,
      );
    }
    await sleep(250);
  }
  console.log(`Phase B result: ${gapSent}/10 high-nonce txs sitting in the mempool (block contention).`);
}

async function phaseC(startNonce: number) {
  // 15 token->MON + 5 MON->token swaps, all successful, to pump the log count
  // inside the contention scanner's 3-minute window.
  const swaps: { data: `0x${string}`; value?: bigint }[] = [
    ...Array.from({ length: 15 }, () => ({ data: swapInToken })),
    ...Array.from({ length: 5 }, () => ({ data: swapInMon, value: 5n * 10n ** 16n })), // 0.05 MON
  ];
  let sent = 0;
  let confirmed = 0;
  for (let i = 0; i < swaps.length; i++) {
    try {
      const hash = await broadcast({
        to: AMM,
        data: swaps[i].data,
        value: swaps[i].value,
        nonce: startNonce + i,
        gas: 300000n,
      });
      sent++;
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status === "success") confirmed++;
      console.log(`[C ${i + 1}/${swaps.length}] swap ${hash} ${receipt.status}`);
    } catch (e: unknown) {
      console.error(
        `[C ${i + 1}/${swaps.length}] failed:`,
        (e as { shortMessage?: string }).shortMessage ?? (e as Error).message,
      );
    }
    await sleep(200);
  }
  console.log(`Phase C result: sent ${sent}, confirmed-success ${confirmed}/${swaps.length}.`);
}

async function main() {
  const baseline = await getContentionScore(AMM);
  console.log("Baseline contention score:", baseline.toFixed(3));

  const startNonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  console.log("Pending nonce at start:", startNonce);

  if (phase.includes("A")) await phaseA(startNonce);
  if (phase.includes("B")) await phaseB(startNonce);

  const pendingMid = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  if (phase.includes("C")) await phaseC(pendingMid);

  const finalContention = await getContentionScore(AMM);
  console.log("Final contention score:", finalContention.toFixed(3));
  console.log("Final pending nonce:", await client.getTransactionCount({ address: account.address, blockTag: "pending" }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
