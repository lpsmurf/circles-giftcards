import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { readFileSync } from 'fs';

const env = readFileSync('./apps/server/.env', 'utf8');
const key = env.match(/^OPERATOR_KEY=(.+)$/m)?.[1]?.trim();
if (!key) { console.error('OPERATOR_KEY not found'); process.exit(1); }

const account = privateKeyToAccount(key);
console.log('Operator:', account.address);

const publicBase = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
const walletBase = createWalletClient({ account, chain: base, transport: http('https://mainnet.base.org') });

const RELAY_API = 'https://api.relay.link';

// Fresh quote
const quoteRes = await fetch(`${RELAY_API}/quote`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user: account.address,
    recipient: account.address,
    originChainId: 8453,
    destinationChainId: 100,
    originCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    destinationCurrency: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83',
    amount: '3000000',
    tradeType: 'EXACT_INPUT',
  }),
});
if (!quoteRes.ok) throw new Error('Quote failed: ' + await quoteRes.text());
const quote = await quoteRes.json();
console.log('Steps:', quote.steps.map(s => s.id).join(', '));

// Execute steps, using the gas from the quote data to avoid estimate failures
for (const step of quote.steps) {
  for (const item of step.items) {
    if (item.status === 'complete') continue;
    const d = item.data;
    const value = (!d.value || d.value === '0' || d.value === '0x0') ? 0n : BigInt(d.value);
    const gas = d.gas ? BigInt(Math.ceil(Number(d.gas) * 1.3)) : undefined; // 30% buffer
    console.log(`\nStep '${step.id}' → ${d.to}, gas: ${gas}`);
    const hash = await walletBase.sendTransaction({ to: d.to, data: d.data, value, gas, chain: base });
    console.log('Hash:', hash);
    const receipt = await publicBase.waitForTransactionReceipt({ hash, timeout: 90_000 });
    console.log('Status:', receipt.status);
    if (receipt.status !== 'success') throw new Error(`Step ${step.id} failed`);
  }
}
console.log('\nAll steps done — Gnosis USDC arrives in ~90s');
