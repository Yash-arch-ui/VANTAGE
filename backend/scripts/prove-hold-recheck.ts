// Prove holdAndRecheck polls over multiple iterations
import { getPSGForecast } from "../src/psg/forecast.js";
import { decidePolicy, holdAndRecheck } from "../src/apa/policy.js";

const tx = {
  from: "0x767166724ec61042ea01c43278b94471c950b824" as `0x${string}`,
  to: "0x7567C23BE5CB52F3B270562180776A95f1bbCa8e" as `0x${string}`,
  data: "0x4312ae310000000000000000000000000000000000000000000000000b1a2bc2ec50000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000056bc75e2d63100000" as `0x${string}`,
  value: 0n,
  nonce: 180,
};
const quoted = 833333333333333333n;

async function main() {
  console.log("=== 1. Initial forecast ===");
  const forecast = await getPSGForecast(tx, quoted);
  console.log(`contentionScore=${forecast.contentionScore}, riskLevel=${forecast.riskLevel}, flags=${JSON.stringify(forecast.flags)}`);

  console.log("\n=== 2. Initial decidePolicy ===");
  const initial = decidePolicy(forecast);
  console.log(`action=${initial.action}, reason=${initial.reason}`);

  console.log("\n=== 3. holdAndRecheck polling (interval 1500ms, timeout 12000ms) ===");
  const start = Date.now();
  const { policy: result } = await holdAndRecheck(tx, quoted, { intervalMs: 1500, timeoutMs: 12000 });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nResolved in ${elapsed}s`);
  console.log(`final action=${result.action}`);
  console.log(`final reason=${result.reason}`);
  if (result.suggestedAdjustment) console.log(`suggestedAdjustment=${result.suggestedAdjustment}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
