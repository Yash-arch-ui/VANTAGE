import "./_env.js"; // MUST be first: loads .env before anything reads process.env
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

const rpcUrl = process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) throw new Error('PRIVATE_KEY is not set — copy .env.example to .env');
const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, '')}`);
const MOCK_ERC20 = '0x4832448eC5578b84c7b13E3EeBA2370Ccfbd5579' as `0x${string}`;
const MOCK_AMM = '0x7567C23BE5CB52F3B270562180776A95f1bbCa8e' as `0x${string}`;

const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain: monadTestnet, transport: http(rpcUrl), account });

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

async function main() {
  const balance = await client.readContract({ address: MOCK_ERC20, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
  console.log('Token balance:', balance.toString());

  const currentAllowance = await client.readContract({ address: MOCK_ERC20, abi: erc20Abi, functionName: 'allowance', args: [account.address, MOCK_AMM] });
  console.log('Current allowance for MockAMM:', currentAllowance.toString());

  if (currentAllowance > 0n) {
    console.log('Already has allowance, resetting to 0 first...');
    const resetTx = await wallet.writeContract({
      address: MOCK_ERC20, abi: erc20Abi, functionName: 'approve',
      args: [MOCK_AMM, 0n], gas: 50000n,
    });
    await client.waitForTransactionReceipt({ hash: resetTx, timeout: 120000 });
    console.log('Allowance reset to 0');
  }

  // Approve MockAMM for 50% of balance (ratio >= 0.5 triggers warning)
  const approveAmount = (balance * 50n) / 100n;
  console.log('Approving MockAMM for', approveAmount.toString(), 'tokens (50% of balance)');

  const approveTx = await wallet.writeContract({
    address: MOCK_ERC20, abi: erc20Abi, functionName: 'approve',
    args: [MOCK_AMM, approveAmount], gas: 50000n,
  });
  console.log('Approve tx:', approveTx);
  const receipt = await client.waitForTransactionReceipt({ hash: approveTx, timeout: 120000 });
  console.log('Approve tx status:', receipt.status);

  if (receipt.status !== 'success') {
    console.log('Approve transaction failed, cannot proceed with approval_exposure test');
    return;
  }

  // Wait for the next watchdog poll cycle
  console.log('Waiting 20s for next watchdog poll cycle...');
  await new Promise(r => setTimeout(r, 20000));

  // Check for approval_exposure alert
  const alertsRes = await fetch('http://localhost:4000/api/alerts?severity=warning');
  const alertsJson = await alertsRes.json();
  const exposureAlert = alertsJson.items.find((a: { type: string }) => a.type === 'approval_exposure');
  if (exposureAlert) {
    console.log('✅ approval_exposure alert found:', JSON.stringify(exposureAlert, null, 2));
  } else {
    console.log('❌ No approval_exposure alert found in warning alerts');
    console.log('All current warning alerts:', JSON.stringify(alertsJson.items.map((a: { type: string; message: string }) => ({ type: a.type, message: a.message }))));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
