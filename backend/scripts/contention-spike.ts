import "./_env.js"; // MUST be first: loads .env before config.ts (via forecast.js) evaluates
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { getContentionScore } from '../src/psg/forecast.js';

const rpcUrl = process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) throw new Error('PRIVATE_KEY is not set — copy .env.example to .env');
const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, '')}`);
const AMM = '0x7567C23BE5CB52F3B270562180776A95f1bbCa8e' as `0x${string}`;

const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });

const mockAmmAbi = parseAbi(['function swap(uint256 minOutput, bool inputIsToken, uint256 inputAmount) payable']);
const swapData = encodeFunctionData({ abi: mockAmmAbi, functionName: 'swap', args: [0n, true, 1000000000000000000n] });

async function main() {
  const baseline = await getContentionScore(AMM);
  console.log('Baseline contention score:', baseline.toFixed(3));

  const startNonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
  console.log('Starting nonce:', startNonce);

  let confirmed = 0;
  for (let i = 0; i < 5; i++) {
    try {
      const hash = await wallet.sendTransaction({ to: AMM, data: swapData, nonce: startNonce + i, gas: 500000n });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status === 'success') { confirmed++; console.log(`Swap ${i+1}/5 confirmed`); }
    } catch (e: unknown) { console.error(`Swap ${i+1}/5 failed:`, (e as { shortMessage?: string }).shortMessage || (e as Error).message); }
  }
  console.log(`Confirmed ${confirmed}/5 swaps`);

  console.log('Waiting 18s for watchdog to poll and record baseline...');
  await new Promise(r => setTimeout(r, 18000));

  const afterBaseline = await getContentionScore(AMM);
  console.log('Contention after baseline swaps:', afterBaseline.toFixed(3));

  const spikeNonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
  console.log('Spike nonce:', spikeNonce);

  let spikeConfirmed = 0;
  for (let i = 0; i < 24; i++) {
    try {
      const hash = await wallet.sendTransaction({ to: AMM, data: swapData, nonce: spikeNonce + i, gas: 500000n });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status === 'success') { spikeConfirmed++; }
    } catch (e: unknown) { console.error(`Spike swap ${i+1}/24 failed:`, (e as { shortMessage?: string }).shortMessage || (e as Error).message); }
  }
  console.log(`Confirmed ${spikeConfirmed}/24 spike swaps`);

  const afterSpike = await getContentionScore(AMM);
  console.log('Contention after spike swaps:', afterSpike.toFixed(3));
  console.log(`Spike ratio: ${(afterSpike / Math.max(afterBaseline, 0.001)).toFixed(1)}x`);

  console.log('Waiting 20s for next watchdog poll cycle...');
  await new Promise(r => setTimeout(r, 20000));

  const alertsRes = await fetch('http://localhost:4000/api/alerts?severity=warning');
  const alertsJson = await alertsRes.json();
  console.log('Warning alerts:', JSON.stringify(alertsJson, null, 2));

  const spikeAlert = alertsJson.items.find((a: { type: string }) => a.type === 'contention_spike');
  if (spikeAlert) {
    console.log('CONTENTION_SPIKE ALERT FOUND:', JSON.stringify(spikeAlert, null, 2));
  } else {
    console.log('No contention_spike alert in warning alerts');
    const allAlerts = await fetch('http://localhost:4000/api/alerts');
    const allJson = await allAlerts.json();
    console.log('All alerts:', JSON.stringify(allJson, null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
