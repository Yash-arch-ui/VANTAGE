// Repro: run the EXACT backend forecast path for a swap of 1 token from the
// max-allowance account, the way POST /evaluate does.
// Run:  npx tsx scripts/repro-swap-forecast.ts
import "./_env.js";
import { encodeFunctionData, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getPSGForecast } from "../src/psg/forecast.js";

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) throw new Error("PRIVATE_KEY not set");
const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, "")}`);
const AMM = "0x7567C23BE5CB52F3B270562180776A95f1bbCa8e" as `0x${string}`;

const ammAbi = parseAbi([
  "function swap(uint256 minOutput, bool inputIsToken, uint256 inputAmount) payable",
]);

async function main() {
  const inputAmount = parseEther("1");
  const data = encodeFunctionData({
    abi: ammAbi,
    functionName: "swap",
    args: [0n, true, inputAmount],
  });

  const { createPublicClient, http } = await import("viem");
  const { monadTestnet } = await import("viem/chains");
  const client = createPublicClient({ chain: monadTestnet, transport: http(process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz") });
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  console.log("account:", account.address, "pending nonce:", nonce);

  const forecast = await getPSGForecast({
    from: account.address,
    to: AMM,
    data,
    value: 0n,
    nonce,
  });

  console.log(JSON.stringify(
    {
      simulationSuccess: forecast.simulationSuccess,
      revertReason: forecast.revertReason,
      flags: forecast.flags,
      nonceCurrent: forecast.nonceCurrent,
      nonceIssue: forecast.nonceIssue,
      contentionScore: forecast.contentionScore,
      riskLevel: forecast.riskLevel,
      gasEstimate: forecast.gasEstimate,
    },
    null,
    2,
  ));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
