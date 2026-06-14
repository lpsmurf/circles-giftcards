import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeChain, activeRpcHttp } from "../config/network.js";

const RPC_HTTP = activeRpcHttp();

// ---- ABIs ------------------------------------------------------------------

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
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

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;

// ---- Public API ------------------------------------------------------------

/**
 * Refund semantics (docs/SECURITY.md):
 *
 *   pre-swap  → send the exact CRC received back to the payer (no deductions;
 *               Gnosis gas is paid by the orchestrator).
 *   post-swap → send USDC back to the payer on Gnosis (user may swap back to
 *               CRC themselves, or we can automate that in M3).
 *
 * Both cases use the same on-chain path: ERC-20 transfer from the Safe (or
 * operator EOA in demo mode) to payerAddress on Gnosis Chain.
 */
export async function executeRefund(params: {
  payerAddress: Address;
  tokenAddress: Address; // CRC for pre-swap, USDC.e for post-swap
  amountWei: bigint;
  orderId: string; // for logging
}): Promise<{ txHash: string }> {
  if (!process.env.OPERATOR_KEY) throw new Error("OPERATOR_KEY not set");

  const account = privateKeyToAccount(process.env.OPERATOR_KEY as Hex);
  const safeAddress = process.env.ORCHESTRATOR_SAFE_ADDRESS as Address | undefined;
  const transport = http(RPC_HTTP);
  const pub = createPublicClient({ chain: activeChain, transport });
  const wallet = createWalletClient({ account, chain: activeChain, transport });

  const callData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [params.payerAddress, params.amountWei],
  });

  console.log(
    `[refundExecutor] ${params.orderId}: refunding ${params.amountWei} of ${params.tokenAddress} → ${params.payerAddress}`
  );

  let txHash: `0x${string}`;

  if (safeAddress) {
    // Safe path: wrap the ERC-20 transfer in an execTransaction
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
        to: params.tokenAddress,
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

    txHash = await wallet.writeContract({
      chain: activeChain,
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "execTransaction",
      args: [
        params.tokenAddress,
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
  } else {
    // EOA path
    txHash = await wallet.writeContract({
      chain: activeChain,
      address: params.tokenAddress,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [params.payerAddress, params.amountWei],
    });
  }

  await pub.waitForTransactionReceipt({ hash: txHash });
  console.log(`[refundExecutor] ${params.orderId}: refund confirmed (tx ${txHash})`);
  return { txHash };
}
