import { createWalletClient, createPublicClient, http, parseAbi, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { readFileSync } from 'fs';

const env = readFileSync('./apps/server/.env', 'utf8');
const key = env.match(/^OPERATOR_KEY=(.+)$/m)?.[1]?.trim();
if (!key) process.exit(1);

const account = privateKeyToAccount(key);
console.log('Operator:', account.address);

const publicBase = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
const walletBase = createWalletClient({ account, chain: base, transport: http('https://mainnet.base.org') });

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';

// Approve LiFi for 1 USDC
console.log('Approving...');
const approveTx = await walletBase.sendTransaction({
  to: USDC_BASE,
  data: encodeFunctionData({
    abi: parseAbi(['function approve(address,uint256) returns (bool)']),
    functionName: 'approve',
    args: [LIFI_DIAMOND, 900000n],
  }),
  gas: 80000n,
});
await publicBase.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
console.log('Approved');

// Fresh quote via StargateV2 (not relay)
const url = 'https://li.quest/v1/quote?fromChain=8453&toChain=100' +
  '&fromToken=' + USDC_BASE +
  '&toToken=0x0000000000000000000000000000000000000000' +
  '&fromAmount=900000&denyBridges=relay' +
  '&fromAddress=' + account.address +
  '&toAddress=' + account.address;

const q = await (await fetch(url)).json();
if (q.message) throw new Error('Quote: ' + q.message);
const tx = q.transactionRequest;
console.log('Route:', q.toolDetails?.name ?? q.tool);
console.log('Expect:', (parseInt(q.estimate.toAmount)/1e18).toFixed(4), 'xDAI');
console.log('Tx value:', tx.value ?? '0');

const hash = await walletBase.sendTransaction({
  to: tx.to, data: tx.data,
  value: tx.value ? BigInt(tx.value) : 0n,
  gas: BigInt(Math.ceil(Number(tx.gasLimit) * 1.2)),
  chain: base,
});
console.log('Tx:', hash);
const receipt = await publicBase.waitForTransactionReceipt({ hash, timeout: 120_000 });
console.log('Status:', receipt.status);
if (receipt.status === 'success') console.log('xDAI inbound (~2 min for Stargate)');
