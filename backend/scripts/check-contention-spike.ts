// CHECK 4 — contention_spike alert raised by the WATCHDOG (not PSG's scanner).
//
// Contention score = Swap logs for MockAMM in the last 180s / 20 (cap 1.0).
// The spike fires when one real poll sees >= 3x the previous poll's contention
// (and >= 0.3 floor). To make that happen with real on-chain traffic:
//   1. approve MockAMM to spend tokens (real tx) so token-input swaps succeed
//   2. fire 3 baseline swaps, wait for a REAL poll to snapshot low contention
//   3. fire a 20-swap burst (real txs, near-parallel, explicit nonces) → logs
//      jump ~7x in a single window
//   4. wait for the NEXT real poll cycle to raise contention_spike
// Nothing here calls compareSnapshots / pollContract — only real HTTP + chain.
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
import Database from "better-sqlite3";
import { config } from "../src/config.js";
import { MOCK_AMM_ADDRESS, mockAmmAbi, getContentionScore } from "../src/psg/forecast.js";

const MOCK_ERC20 = "0x4832448eC5578b84c7b13E3EeBA2370Ccfbd5579" as Address;
const SWAP_INPUT_AMOUNT = 1n * 10n ** 17n; // 0.1 token per swap
const GAS_LIMIT = 500_000n;
const BASELINE_SWAPS = 3;
const BURST_SWAPS = 20;
const POLL_MS = 15_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

function encodeSwap(minOutput: bigint): Hex {
  return encodeFunctionData({
    abi: mockAmmAbi,
    functionName: "swap",
    args: [minOutput, true, SWAP_INPUT_AMOUNT],
  });
}

async function sendAndConfirm(
  wallet: ReturnType<typeof createWalletClient>,
  client: ReturnType<typeof createPublicClient>,
  to: Address,
  data: Hex,
  nonce: number,
): Promise<{ ok: boolean; status: string }> {
  try {
    const hash = await wallet.sendTransaction({ to, data, nonce, gas: GAS_LIMIT });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    return { ok: receipt.status === "success", status: receipt.status };
  } catch (e) {
    return { ok: false, status: `err: ${(e as { shortMessage?: string }).shortMessage ?? "unknown"}` };
  }
}

async function waitForPollChange(db: Database.Database, amm: string, lastSeen: string | null): Promise<string> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const row = db
      .prepare("SELECT last_checked FROM watchlist WHERE contract_address = ?")
      .get(amm) as { last_checked: string | null } | undefined;
    const lc = row?.last_checked ?? null;
    if (lc !== null && lc !== lastSeen) return lc;
    await sleep(500);
  }
  return lastSeen;
}

async function main(): Promise<void> {
  const { privateKey, rpcUrl } = config;
  const account = privateKeyToAccount(`0x${privateKey}`);
  const amm = MOCK_AMM_ADDRESS as Address;
  const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });
  const db = new Database("./vantage.db", { readonly: true });

  console.log(`[${ts()}] sender=${account.address} AMM=${amm}`);

  // 0. Current contention (expect ~0 — reverts emit no Swap logs)
  console.log(`[${ts()}] contention before = ${(await getContentionScore(amm)).toFixed(3)}`);

  // 1. Approve MockAMM for 50% of balance — lets token-input swaps succeed.
  const balance = (await client.readContract({
    address: MOCK_ERC20, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  })) as bigint;
  const approveAmount = (balance * 50n) / 100n;
  const nonce0 = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const approveHash = await wallet.writeContract({
    address: MOCK_ERC20, abi: erc20Abi, functionName: "approve", args: [amm, approveAmount], nonce: nonce0, gas: 60_000n,
  });
  const approveReceipt = await client.waitForTransactionReceipt({ hash: approveHash, timeout: 90_000 });
  console.log(`[${ts()}] approved ${amm} for ${approveAmount} tokens (${(Number(approveAmount) / Number(balance) * 100).toFixed(1)}% of balance) — status=${approveReceipt.status}`);

  // 2. Baseline: 3 successful swaps, then let a REAL poll snapshot low contention.
  const expected0 = (await client.readContract({
    address: amm, abi: mockAmmAbi, functionName: "getExpectedOutput", args: [SWAP_INPUT_AMOUNT, true],
  })) as bigint;
  const safeMin = (expected0 * 90n) / 100n; // 10% slippage buffer → succeeds
  const baseData = encodeSwap(safeMin);
  console.log(`[${ts()}] baseline: ${BASELINE_SWAPS} successful swaps (minOutput=${safeMin}, 90% of expected ${expected0})`);
  let nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  let baseOk = 0;
  for (let i = 0; i < BASELINE_SWAPS; i++) {
    const r = await sendAndConfirm(wallet, client, amm, baseData, nonce++);
    if (r.ok) baseOk++;
    console.log(`[${ts()}]   baseline swap ${i + 1}/${BASELINE_SWAPS} → ${r.status}`);
  }
  console.log(`[${ts()}] baseline swaps confirmed: ${baseOk}/${BASELINE_SWAPS}`);
  if (baseOk === 0) throw new Error("no baseline swaps confirmed — cannot establish contention baseline");

  // Wait for the baseline to be visible on-chain, then for a real poll to snapshot it.
  let contentionBaseline = 0;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    contentionBaseline = await getContentionScore(amm);
    if (contentionBaseline >= 0.05) break;
    await sleep(1_000);
  }
  console.log(`[${ts()}] baseline contention visible on-chain = ${contentionBaseline.toFixed(3)} — waiting for a real poll to snapshot it…`);
  const lastChecked = (db.prepare("SELECT last_checked FROM watchlist WHERE contract_address = ?").get(amm) as { last_checked: string | null }).last_checked;
  const after = await waitForPollChange(db, amm, lastChecked);
  console.log(`[${ts()}] poll captured baseline at last_checked=${after}`);

  // 3. Burst: 20 successful swaps, near-parallel with explicit nonces → land between two polls.
  console.log(`[${ts()}] burst: submitting ${BURST_SWAPS} swaps (nonce ${nonce}..${nonce + BURST_SWAPS - 1})…`);
  const burstStart = Date.now();
  const sends = [];
  for (let i = 0; i < BURST_SWAPS; i++) {
    sends.push(wallet.sendTransaction({ to: amm, data: baseData, nonce: nonce + i, gas: GAS_LIMIT }).catch((e) => ({ err: e as { shortMessage?: string } })));
  }
  const results = await Promise.all(sends);
  let submitted = 0;
  const hashes: Hex[] = [];
  for (const r of results) {
    if (typeof r !== "string") { console.log(`[${ts()}]   burst submit error: ${r.err?.shortMessage ?? "unknown"}`); continue; }
    submitted++;
    hashes.push(r);
  }
  console.log(`[${ts()}] burst submitted ${submitted}/${BURST_SWAPS} in ${((Date.now() - burstStart) / 1000).toFixed(1)}s — waiting for all to mine…`);
  const receipts = await Promise.all(hashes.map((h) => client.waitForTransactionReceipt({ hash: h, timeout: 120_000 }).catch(() => null)));
  const burstOk = receipts.filter((rc) => rc?.status === "success").length;
  const burstFailed = receipts.filter((rc) => rc && rc.status !== "success").length;
  console.log(`[${ts()}] burst mined: ${burstOk} success, ${burstFailed} reverted, ${receipts.length - burstOk - burstFailed} not found`);

  const contentionNow = await getContentionScore(amm);
  console.log(`[${ts()}] contention now = ${contentionNow.toFixed(3)} (multiplier vs baseline ${(contentionNow / Math.max(contentionBaseline, 0.001)).toFixed(1)}x)`);

  // 4. Wait for the NEXT real poll to raise contention_spike.
  console.log(`[${ts()}] waiting for the next REAL poll cycle to raise contention_spike…`);
  const spikeDeadline = Date.now() + 40_000;
  let spike: { id: string; type: string; severity: string; message: string; created_at: string } | undefined;
  while (Date.now() < spikeDeadline) {
    spike = db
      .prepare("SELECT id, type, severity, message, created_at FROM alerts WHERE contract_address = ? AND type = 'contention_spike' ORDER BY created_at DESC LIMIT 1")
      .get(amm) as typeof spike | undefined;
    if (spike) break;
    await sleep(1_000);
  }
  if (!spike) {
    console.error(`[${ts()}] ✗ NO contention_spike alert appeared (baseline=${contentionBaseline.toFixed(3)}, after=${contentionNow.toFixed(3)})`);
    db.close();
    return;
  }
  console.log(`[${ts()}] ✓ contention_spike alert: id=${spike.id.slice(0, 8)} severity=${spike.severity} created=${spike.created_at}`);
  console.log(`[${ts()}]   message="${spike.message}"`);
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
