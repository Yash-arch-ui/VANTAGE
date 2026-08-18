// Flood the Monad testnet mempool with a burst of PARALLEL, unawaited swap
// transactions so the Execution Conflict Analyzer (ECA) has real competitors
// to count when you hit Evaluate in the Guard console.
//
// Why parallel + unawaited: the ECA reads the PENDING BLOCK — transactions
// still sitting in the mempool, never confirmed ones. prove-contention.ts
// awaits every receipt, so its swaps only drive the time-based contention
// window and never appear as pending competitors. This script fires all its
// swaps at once with explicit sequential nonces and never waits for receipts,
// so a pile of them is pending simultaneously — exactly what the ECA counts
// as competingSwapCount / competingTxCount.
//
// Same-sender rule: the ECA excludes the sender's own pending transactions
// (a sender's nonce sequence serializes, so they can never race), so the
// wallet you evaluate from in the frontend MUST be a different address than
// PRIVATE_KEY. PRIVATE_KEY is the "flooder"; the frontend wallet is the
// "evaluator".
//
// The script mints DEMO + approves the AMM for the flooder automatically
// (anyone can mint on testnet), so the burst is one command.
//
// Run from backend/:
//   npx tsx scripts/flood-mempool.ts              # 3 waves x 40 swaps (~15s flooded window)
//   npx tsx scripts/flood-mempool.ts --waves=5    # keep the mempool flooded longer
//   npx tsx scripts/flood-mempool.ts --count=60   # bigger pile per wave
//   npx tsx scripts/flood-mempool.ts --claim=1    # same-slot claim race instead
//
// Why waves: Monad testnet mines in ~1-2s, so a single burst drains before a
// human can click Evaluate. Later waves carry HIGHER nonces, so they cannot
// mine until the earlier waves confirm — the pile stays in the pending block
// for many seconds while you click.
import "./_env.js"; // MUST be first: loads .env before config.ts (via forecast.js) evaluates
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  decodeFunctionData,
  maxUint256,
  parseAbi,
  parseEther,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { config } from "../src/config.js";
import {
  AMM_ADDRESS,
  CLAIM_CONTRACT_ADDRESS,
  ammAbi,
  claimContractAbi,
} from "../src/psg/forecast.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const BURST = parseInt(flag("count", "40"), 10);
const WAVES = parseInt(flag("waves", "3"), 10);
const WAVE_GAP_MS = 1_200;
const claimSlotRaw = flag("claim", "");
const claimSlot = claimSlotRaw === "" ? null : BigInt(claimSlotRaw);

const erc20Abi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const SWAP_SELECTOR = toFunctionSelector("swap(uint256,bool,uint256)");

async function main() {
  const { privateKey, rpcUrl } = config;
  if (!privateKey) throw new Error("PRIVATE_KEY is not set in .env");
  const account = privateKeyToAccount(`0x${privateKey}`);
  console.log(`flooder = ${account.address}`);

  const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });

  const target = claimSlot !== null ? CLAIM_CONTRACT_ADDRESS : AMM_ADDRESS;

  // Live count of pending txs to the target (and how many match the burst), so
  // the video captures the exact moment the mempool is loaded.
  const countPending = async () => {
    const block = await client.getBlock({ blockTag: "pending", includeTransactions: true });
    const txs = (block.transactions ?? []) as unknown as { to: string | null; input: string }[];
    let toTarget = 0;
    let matching = 0;
    for (const t of txs) {
      if ((t.to ?? "").toLowerCase() !== target.toLowerCase()) continue;
      toTarget++;
      if (claimSlot !== null) {
        try {
          const d = decodeFunctionData({ abi: claimContractAbi, data: t.input as Hex });
          if (d.functionName === "claim" && d.args[0] === claimSlot) matching++;
        } catch {
          // not a claim call
        }
      } else if (t.input?.startsWith(SWAP_SELECTOR)) {
        matching++;
      }
    }
    return { toTarget, matching };
  };

  if (claimSlot !== null) {
    const claimed = await client.readContract({
      address: CLAIM_CONTRACT_ADDRESS,
      abi: claimContractAbi,
      functionName: "isClaimed",
      args: [claimSlot],
    });
    if (claimed) {
      console.error(`slot ${claimSlot} is already claimed — pick a free slot (0-9).`);
      process.exitCode = 1;
      return;
    }
    console.log(`racing claims on slot ${claimSlot} of ClaimContract (${CLAIM_CONTRACT_ADDRESS})`);
  } else {
    // Top up + allow the flooder to swap: mint DEMO (anyone can mint on
    // testnet) and approve the AMM to pull it.
    const token = (await client.readContract({
      address: AMM_ADDRESS,
      abi: ammAbi,
      functionName: "token",
    })) as Address;
    const balance = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    if (balance < parseEther("5")) {
      const hash = await wallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "mint",
        args: [account.address, parseEther("1000")],
      });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      console.log(`minted 1000 DEMO (${receipt.status})`);
    } else {
      console.log("flooder already holds DEMO — skipping mint");
    }
    await wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [AMM_ADDRESS, maxUint256],
    });
    console.log(`approved AMM for unlimited DEMO (${AMM_ADDRESS})`);
    console.log(`burst  = ${BURST} parallel swaps (0.1 DEMO each)`);
  }

  console.log("\nGet your cursor on the frontend's Evaluate button…");
  for (let i = 3; i >= 1; i--) {
    console.log(`  ${i}…`);
    await sleep(1000);
  }

  const data =
    claimSlot !== null
      ? encodeFunctionData({ abi: claimContractAbi, functionName: "claim", args: [claimSlot] })
      : encodeFunctionData({
          abi: ammAbi,
          functionName: "swap",
          // minOutput 0: the AMM's own slippage guard must not revert the flood.
          args: [0n, true, parseEther("0.1")],
        });

  const t0 = Date.now();

  // Fire WAVES of BURST txs each. The pending nonce is re-fetched every wave:
  // if the previous wave mined, it has advanced; if not, the count still
  // includes those txs, so the new nonces never collide with the old ones.
  let wave = 0;
  while (wave < WAVES) {
    const waveNonce = await client.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });
    const hashes = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        wallet.sendTransaction({ to: target, data, nonce: waveNonce + i, gas: 500_000n }),
      ),
    );
    wave++;
    console.log(
      `\n🌊 wave ${wave}/${WAVES}: ${hashes.length} txs pending (nonce ${waveNonce}..${waveNonce + BURST - 1})${wave === 1 ? " — CLICK EVALUATE NOW" : " — mempool re-topped"}`,
    );
    if (wave === 1) hashes.slice(0, 3).forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
    if (wave < WAVES) await sleep(WAVE_GAP_MS);
  }

  // Watch the pending block drain so the video captures the window.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { toTarget, matching } = await countPending();
    const label = claimSlot !== null ? "same-slot claims" : "AMM swaps";
    console.log(
      `  pending: ${toTarget} txs to target, ${matching} ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
    if (toTarget === 0) break;
    await sleep(1000);
  }

  const confirmed = await client.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  console.log(
    `\nflood over — ${BURST * WAVES} txs sent, account at nonce ${confirmed} (mined + still pending). The 3-minute contention window stays hot; re-evaluate to watch HOLD_AND_RECHECK persist.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
