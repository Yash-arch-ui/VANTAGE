import "./_env.js"; // MUST be first: loads .env before anything reads process.env
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

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
  // Step 1: Fire a successful on-chain swap to establish a clean baseline
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
  console.log('Nonce:', nonce);

  const hash = await wallet.sendTransaction({ to: AMM, data: swapData, nonce, gas: 500000n });
  console.log('Tx hash:', hash);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 });
  console.log('Tx status:', receipt.status);

  // Step 2: Call POST /evaluate with a clean swap against MockAMM
  // Use a fresh nonce so the tx is valid
  const freshNonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
  console.log('Fresh nonce for evaluate:', freshNonce);

  const resp = await fetch('http://localhost:4000/api/evaluate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tx: {
        from: account.address,
        to: AMM,
        data: swapData,
        value: '0',
        nonce: freshNonce
      }
    })
  });
  const json = await resp.json();
  console.log('Evaluate response status:', resp.status);
  console.log('Policy action:', json.policy?.action);
  console.log('Policy reason:', json.policy?.reason);
  console.log('Forecast flags:', json.forecast?.flags);
  console.log('Entry ID:', json.entryId);

  // Verify the watchdog bias kicked in
  if (json.policy?.action === 'WARN' && json.policy?.reason?.includes('Watchdog:')) {
    console.log('✅ CHECK 6 PASS — applyWatchdogBias bias applied end-to-end');
  } else if (json.policy?.action === 'PROCEED') {
    console.log('❌ CHECK 6 FAIL — policy is PROCEED, watchdog bias did not apply');
  } else {
    console.log('⚠️  CHECK 6 — unexpected policy action:', json.policy?.action);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
