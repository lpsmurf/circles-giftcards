// Swap 0.5 Gnosis USDC → xDAI using CoW Protocol order API
import { createWalletClient, createPublicClient, http, parseUnits, parseAbi, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { readFileSync } from 'fs';

const env = readFileSync('./apps/server/.env', 'utf8');
const key = env.match(/^OPERATOR_KEY=(.+)$/m)?.[1]?.trim();
if (!key) { console.error('OPERATOR_KEY not found'); process.exit(1); }

const account = privateKeyToAccount(key);
console.log('Operator:', account.address);

const COW_API = 'https://api.cow.fi/xdai/api/v1';
const USDC_GNOSIS = '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83';
const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';

const publicClient = createPublicClient({ chain: gnosis, transport: http('https://gnosis-rpc.publicnode.com') });
const walletClient = createWalletClient({ account, chain: gnosis, transport: http('https://gnosis-rpc.publicnode.com') });

const sellAmount = parseUnits('0.5', 6); // 0.5 USDC

// 1. Approve CoW vault relayer to spend USDC
console.log('Approving CoW vault relayer...');
const approveData = encodeFunctionData({
  abi: parseAbi(['function approve(address,uint256) returns (bool)']),
  functionName: 'approve',
  args: [COW_VAULT_RELAYER, sellAmount],
});
const approveTx = await walletClient.sendTransaction({ to: USDC_GNOSIS, data: approveData });
console.log('Approve tx:', approveTx);
await publicClient.waitForTransactionReceipt({ hash: approveTx });
console.log('Approved');

// 2. Get quote from CoW
const quoteRes = await fetch(`${COW_API}/quote`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sellToken: USDC_GNOSIS,
    buyToken: WXDAI,
    receiver: account.address,
    sellAmountBeforeFee: sellAmount.toString(),
    from: account.address,
    kind: 'sell',
    partiallyFillable: false,
    signingScheme: 'eip712',
  }),
});
if (!quoteRes.ok) throw new Error('Quote failed: ' + await quoteRes.text());
const { quote } = await quoteRes.json();
console.log('Quote: sell', quote.sellAmount, 'USDC → buy', (BigInt(quote.buyAmount)/BigInt(1e18)).toString(), '+ xDAI');

// 3. Sign and submit order
const domain = { name: 'Gnosis Protocol', version: 'v2', chainId: 100, verifyingContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' };
const orderTypes = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'bytes32' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'bytes32' },
    { name: 'buyTokenBalance', type: 'bytes32' },
  ],
};
const orderData = {
  sellToken: USDC_GNOSIS,
  buyToken: WXDAI,
  receiver: account.address,
  sellAmount: BigInt(quote.sellAmount),
  buyAmount: BigInt(quote.buyAmount),
  validTo: quote.validTo,
  appData: quote.appData,
  feeAmount: BigInt(quote.feeAmount),
  kind: '0xf3b277728b3fee749481eb3e0b3b48980dbbab78deafebb9798e4bc1001babb3', // sell
  partiallyFillable: false,
  sellTokenBalance: '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9', // erc20
  buyTokenBalance: '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9', // erc20
};

const sig = await walletClient.signTypedData({ domain, types: orderTypes, primaryType: 'Order', message: orderData });

const orderRes = await fetch(`${COW_API}/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sellToken: USDC_GNOSIS,
    buyToken: WXDAI,
    receiver: account.address,
    sellAmount: quote.sellAmount,
    buyAmount: quote.buyAmount,
    validTo: quote.validTo,
    appData: quote.appData,
    feeAmount: quote.feeAmount,
    kind: 'sell',
    partiallyFillable: false,
    signature: sig,
    signingScheme: 'eip712',
    from: account.address,
  }),
});
if (!orderRes.ok) throw new Error('Order failed: ' + await orderRes.text());
const orderId = await orderRes.json();
console.log('CoW order placed:', orderId);
console.log('Monitor: https://explorer.cow.fi/gc/orders/' + orderId);
