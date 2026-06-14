import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { quoteSellForExactBuy } from "@circles-giftcards/swap-router";
import { activeChain, activeRpcHttp, activeCowApiUrl, TESTNET } from "../config/network.js";

const COW_API = activeCowApiUrl();
const COW_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as Address;
const RPC_HTTP = activeRpcHttp();

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60_000; // CoW batches on Gnosis run every ~30s

// Identifies this app's orders in the CoW explorer; replace with a registered
// CID once we have a CoW app data registry entry.
const APP_DATA =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

const KIND_BUY = keccak256(toBytes("buy"));
const BALANCE_ERC20 = keccak256(toBytes("erc20"));
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;

// ---- ABIs (minimal) --------------------------------------------------------

const SETTLEMENT_ABI = [
  {
    name: "setPreSignature",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderUid", type: "bytes" },
      { name: "signed", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const SAFE_ABI = [
  {
    name: "nonce",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "execTransaction",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

// ---- EIP-712 type definitions -----------------------------------------------

const COW_DOMAIN = {
  name: "Gnosis Protocol",
  version: "v2",
  chainId: activeChain.id,
  verifyingContract: COW_SETTLEMENT,
} as const;

const COW_ORDER_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "bytes32" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "bytes32" },
    { name: "buyTokenBalance", type: "bytes32" },
  ],
} as const;

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

// ---- Helpers ----------------------------------------------------------------

type CowQuote = Awaited<ReturnType<typeof quoteSellForExactBuy>>;

async function postCowOrder(params: {
  quote: CowQuote;
  receiver: Address;
  signingScheme: "eip712" | "presign";
  signature: string;
  from: Address;
}): Promise<string> {
  const { quote, receiver, signingScheme, signature, from } = params;
  const res = await fetch(`${COW_API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sellToken: quote.sellToken,
      buyToken: quote.buyToken,
      receiver,
      sellAmount: quote.sellAmount.toString(),
      buyAmount: quote.buyAmount.toString(),
      validTo: quote.validTo,
      appData: APP_DATA,
      feeAmount: quote.feeAmount.toString(),
      kind: "buy",
      partiallyFillable: false,
      sellTokenBalance: "erc20",
      buyTokenBalance: "erc20",
      signingScheme,
      signature,
      from,
    }),
  });
  if (!res.ok) {
    throw new Error(`CoW order POST ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<string>; // CoW returns orderUid as a JSON string
}

/** Check a previously submitted CoW order. Returns fill tx hash if fulfilled,
 *  null if still open, throws if cancelled/expired. */
export async function checkCowOrderFill(
  orderUid: string
): Promise<{ filled: boolean; fillTxHash?: string }> {
  const res = await fetch(`${COW_API}/orders/${orderUid}`);
  if (!res.ok) throw new Error(`CoW GET order ${res.status}`);
  const o = (await res.json()) as { status: string; txHash?: string };
  if (o.status === "fulfilled") return { filled: true, fillTxHash: o.txHash ?? "0x" };
  if (o.status === "cancelled" || o.status === "expired") {
    throw new Error(`CoW order ${o.status}`);
  }
  return { filled: false };
}

async function pollForFill(orderUid: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${COW_API}/orders/${orderUid}`);
    if (res.ok) {
      const o = (await res.json()) as { status: string; txHash?: string };
      if (o.status === "fulfilled") return o.txHash ?? "0x";
      if (o.status === "cancelled" || o.status === "expired") {
        throw new Error(`CoW order ${o.status}`);
      }
    }
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`CoW order ${orderUid} not filled within ${POLL_TIMEOUT_MS / 1000}s`);
}

// ---- Public API -------------------------------------------------------------

/**
 * Re-quote from CoW at execution time and execute the CRC → USDC swap.
 * Re-quoting ensures a fresh limit price; the slippage buffer already baked
 * into crcRequiredWei covers normal price movement between user quote and fill.
 *
 * Signing modes:
 *   - Safe presign  when ORCHESTRATOR_SAFE_ADDRESS is set (production)
 *   - EOA EIP-712   otherwise (local testing with a bare private key)
 */
export async function executeSwap(params: {
  usdcNeededWei: bigint;
  crcToken: Address;
}): Promise<{ orderUid: string; fillTxHash: string }> {
  if (!process.env.OPERATOR_KEY) throw new Error("OPERATOR_KEY not set");

  // In testnet mode CoW Protocol has no Chiado liquidity — return a realistic mock.
  if (TESTNET) {
    const mockUid = `0x${"ab".repeat(28)}${Date.now().toString(16).padStart(8, "0")}`;
    const mockTx = `0x${"cd".repeat(32)}` as `0x${string}`;
    console.log(`[swapExecutor] TESTNET — mock swap: uid=${mockUid}`);
    return { orderUid: mockUid, fillTxHash: mockTx };
  }

  const account = privateKeyToAccount(process.env.OPERATOR_KEY as Hex);
  const transport = http(RPC_HTTP);
  const pub = createPublicClient({ chain: activeChain, transport });
  const wallet = createWalletClient({ account, chain: activeChain, transport });
  const safeAddress = process.env.ORCHESTRATOR_SAFE_ADDRESS as Address | undefined;
  const from = safeAddress ?? account.address;

  console.log(`[swapExecutor] re-quoting ${params.usdcNeededWei} USDC from CoW...`);
  const quote = await quoteSellForExactBuy({
    sellToken: params.crcToken,
    buyAmountWei: params.usdcNeededWei,
    receiver: from,
    from,
  });
  console.log(
    `[swapExecutor] sell ${quote.sellAmount} CRC → buy ${quote.buyAmount} USDC` +
      (safeAddress ? " (Safe presign)" : " (EOA EIP-712)")
  );

  // ---- EOA path: EIP-712 signature from the operator key directly -----------
  if (!safeAddress) {
    const signature = await wallet.signTypedData({
      domain: COW_DOMAIN,
      types: COW_ORDER_TYPES,
      primaryType: "Order",
      message: {
        sellToken: quote.sellToken as Address,
        buyToken: quote.buyToken as Address,
        receiver: account.address,
        sellAmount: quote.sellAmount,
        buyAmount: quote.buyAmount,
        validTo: quote.validTo,
        appData: APP_DATA,
        feeAmount: quote.feeAmount,
        kind: KIND_BUY,
        partiallyFillable: false,
        sellTokenBalance: BALANCE_ERC20,
        buyTokenBalance: BALANCE_ERC20,
      },
    });

    const orderUid = await postCowOrder({
      quote,
      receiver: account.address,
      signingScheme: "eip712",
      signature,
      from: account.address,
    });
    const fillTxHash = await pollForFill(orderUid);
    return { orderUid, fillTxHash };
  }

  // ---- Safe path: submit presign order, then activate via execTransaction ---

  // 1. Submit order (not active yet — CoW waits for setPreSignature)
  const orderUid = await postCowOrder({
    quote,
    receiver: safeAddress,
    signingScheme: "presign",
    signature: safeAddress, // CoW expects the signer address as the "signature"
    from: safeAddress,
  });

  // 2. Build setPreSignature calldata
  const callData = encodeFunctionData({
    abi: SETTLEMENT_ABI,
    functionName: "setPreSignature",
    args: [orderUid as Hex, true],
  });

  // 3. Sign the Safe transaction (EIP-712, Safe's own domain)
  const nonce = await pub.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "nonce",
  });

  const safeSig = await wallet.signTypedData({
    domain: { chainId: activeChain.id, verifyingContract: safeAddress },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message: {
      to: COW_SETTLEMENT,
      value: 0n,
      data: callData,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO_ADDR,
      refundReceiver: ZERO_ADDR,
      nonce,
    },
  });

  // 4. Execute via Safe — operator pays xDAI gas (~$0.001 on Gnosis)
  const execHash = await wallet.writeContract({
    chain: activeChain,
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args: [
      COW_SETTLEMENT,
      0n,
      callData,
      0,
      0n,
      0n,
      0n,
      ZERO_ADDR,
      ZERO_ADDR,
      safeSig,
    ],
  });
  await pub.waitForTransactionReceipt({ hash: execHash });
  console.log(`[swapExecutor] Safe pre-signed ${orderUid} (tx ${execHash})`);

  // 5. Poll until CoW solvers fill the order in the next batch
  const fillTxHash = await pollForFill(orderUid);
  return { orderUid, fillTxHash };
}
