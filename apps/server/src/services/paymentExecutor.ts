import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis, gnosisChiado, base, polygon } from "viem/chains";
import type { Chain } from "viem";
import { selectSettlementChain, executeBridge, CANDIDATES } from "@circles-giftcards/swap-router";
import {
  validateOrder,
  createOrder,
  getOrderStatus,
  getPaymentViasWithCurrencies,
} from "@circles-giftcards/cryptorefills-client";

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

// ---- Chain registry --------------------------------------------------------

import { TESTNET, activeChain, activeRpcHttp } from "../config/network.js";

const CHAIN_BY_ID: Record<number, Chain> = {
  100: gnosis,
  10200: gnosisChiado,
  8453: base,
  137: polygon,
};

function rpcFor(chainId: number): string {
  if (chainId === 100 || chainId === 10200) return activeRpcHttp();
  if (chainId === 8453) return process.env.BASE_RPC_HTTP ?? "https://mainnet.base.org";
  if (chainId === 137) return process.env.POLYGON_RPC_HTTP ?? "https://polygon-rpc.com";
  throw new Error(`no RPC configured for chainId ${chainId}`);
}

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

// ---- Polling ---------------------------------------------------------------

/** Poll Cryptorefills for delivery STATUS only. The gift card code is emailed
 *  directly to the buyer — we deliberately never read the code field, so the
 *  orchestrator holds no custody of codes (NON-CUSTODIAL CODE POLICY). */
async function pollForDelivery(upstreamOrderId: string): Promise<boolean> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = (await getOrderStatus(upstreamOrderId)) as { status?: string };
    const s = (status.status ?? "").toUpperCase();
    if (s === "DELIVERED") return true;
    if (s === "FAILED" || s === "CANCELLED") {
      throw new Error(`Cryptorefills order ${s.toLowerCase()}`);
    }
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Cryptorefills order ${upstreamOrderId} not delivered within ${POLL_TIMEOUT_MS / 1000}s`
  );
}

// ---- Public API ------------------------------------------------------------

/** Resume delivery confirmation for an order that already has an upstreamOrderId
 *  (payment was sent but the server restarted before delivery was confirmed).
 *  Returns whether Cryptorefills reports the order as DELIVERED. */
export async function resumePaymentPolling(params: {
  upstreamOrderId: string;
}): Promise<boolean> {
  try {
    return await pollForDelivery(params.upstreamOrderId);
  } catch (err) {
    console.warn(`[paymentExecutor] resume poll error for ${params.upstreamOrderId}:`, err);
    return false;
  }
}

export interface PaymentResult {
  upstreamOrderId: string;
  paymentTxHash: string;
  bridgeTxHash: string | null;
  delivered: boolean;
}

/**
 * Full x402 payment flow:
 *  1. Ask Cryptorefills which chains they accept for USDC.
 *  2. Pick the cheapest settlement chain (Gnosis first; Base via Relay.link otherwise).
 *  3. Create the Cryptorefills order on the chosen chain.
 *  4. Bridge USDC from Gnosis to the settlement chain if needed.
 *  5. Transfer USDC to Cryptorefills' payment address.
 *  6. Poll getOrderStatus until DELIVERED; return the gift card code.
 */
export async function executePayment(params: {
  brand: string;
  country: string;
  faceValue: number;
  usdcNeededWei: bigint;
  recipientEmail: string;
}): Promise<PaymentResult> {
  if (!process.env.OPERATOR_KEY) throw new Error("OPERATOR_KEY not set");

  // In testnet mode Cryptorefills is not available — simulate direct delivery.
  if (TESTNET) {
    console.log(`[paymentExecutor] TESTNET — simulated delivery to ${params.recipientEmail}`);
    return {
      upstreamOrderId: `testnet-${Date.now()}`,
      paymentTxHash: `0x${"ef".repeat(32)}`,
      bridgeTxHash: null,
      delivered: true,
    };
  }

  const account = privateKeyToAccount(process.env.OPERATOR_KEY as Hex);
  const safeAddress = process.env.ORCHESTRATOR_SAFE_ADDRESS as Address | undefined;
  const operatorAddress = safeAddress ?? account.address;

  // ---- 1. Discover accepted chains ----------------------------------------
  const vias = (await getPaymentViasWithCurrencies()) as Array<{
    coin?: string;
    network?: string;
    chain?: string;
  }>;
  const acceptedChains = [
    ...new Set(
      vias
        .filter((v) => v.coin === "USDC" || v.coin === "USDT")
        .map((v) => (v.network ?? v.chain ?? "").toLowerCase())
        .filter(Boolean)
    ),
  ];
  if (acceptedChains.length === 0) throw new Error("no USDC-accepting chains from Cryptorefills");
  console.log(`[paymentExecutor] accepted chains: ${acceptedChains.join(", ")}`);

  // ---- 2. Pick cheapest settlement chain -----------------------------------
  const route = await selectSettlementChain({
    amountUsdcWei: params.usdcNeededWei,
    acceptedChainNames: acceptedChains,
    operatorAddress,
  });
  console.log(
    `[paymentExecutor] route → ${route.chain.name} (bridge $${route.bridgeFeeUsd.toFixed(3)}, gas $${route.chain.estGasUsd})`
  );

  const settlementChain = CHAIN_BY_ID[route.chain.chainId];
  if (!settlementChain) throw new Error(`no viem chain for chainId ${route.chain.chainId}`);

  // ---- 3. Validate + create Cryptorefills order ----------------------------
  // The buyer's own email is passed so Cryptorefills delivers the gift card code
  // DIRECTLY to them. The orchestrator never receives or stores the code
  // (NON-CUSTODIAL CODE POLICY).
  await validateOrder({
    brand_name: params.brand,
    country_code: params.country,
    face_value: params.faceValue,
    coin: "USDC",
    network: route.chain.name,
    email: params.recipientEmail,
  });

  const orderResult = (await createOrder({
    brand_name: params.brand,
    country_code: params.country,
    face_value: params.faceValue,
    coin: "USDC",
    network: route.chain.name,
    email: params.recipientEmail,
  })) as {
    order_id?: string;
    payment_details?: { address?: string; amount?: string };
  };

  if (
    !orderResult.order_id ||
    !orderResult.payment_details?.address ||
    !orderResult.payment_details?.amount
  ) {
    throw new Error(`createOrder unexpected shape: ${JSON.stringify(orderResult)}`);
  }

  const upstreamOrderId = orderResult.order_id;
  const paymentAddress = orderResult.payment_details.address as Address;
  const paymentAmountWei = BigInt(
    Math.ceil(parseFloat(orderResult.payment_details.amount) * 1e6)
  );
  console.log(`[paymentExecutor] upstream ${upstreamOrderId}: pay ${paymentAmountWei} USDC → ${paymentAddress}`);

  // ---- 4. Bridge Gnosis → settlement chain if needed ----------------------
  let bridgeTxHash: string | null = null;

  if (route.chain.chainId !== 100) {
    console.log(`[paymentExecutor] bridging to ${route.chain.name} via Relay.link...`);
    const gnosisTransport = http(rpcFor(100));
    const gnosisPub = createPublicClient({ chain: gnosis, transport: gnosisTransport });
    const gnosisWallet = createWalletClient({ account, chain: gnosis, transport: gnosisTransport });

    const bridgeResult = await executeBridge(
      {
        originChainId: 100,
        destinationChainId: route.chain.chainId,
        currency: CANDIDATES[0].usdcAddress,
        toCurrency: route.chain.usdcAddress,
        amountWei: params.usdcNeededWei,
        recipient: account.address, // bridge to EOA; Safe is Gnosis-only in M2
        user: operatorAddress,
      },
      async (tx) => {
        // Bridge steps run on Gnosis. Route through Safe if configured.
        if (safeAddress && tx.chainId === 100) {
          const nonce = await gnosisPub.readContract({
            address: safeAddress,
            abi: SAFE_ABI,
            functionName: "nonce",
          });
          const safeSig = await gnosisWallet.signTypedData({
            domain: { chainId: activeChain.id, verifyingContract: safeAddress },
            types: SAFE_TX_TYPES,
            primaryType: "SafeTx",
            message: {
              to: tx.to as Address,
              value: tx.value,
              data: tx.data as Hex,
              operation: 0,
              safeTxGas: 0n,
              baseGas: 0n,
              gasPrice: 0n,
              gasToken: ZERO_ADDR,
              refundReceiver: ZERO_ADDR,
              nonce,
            },
          });
          const hash = await gnosisWallet.writeContract({
            chain: gnosis,
            address: safeAddress,
            abi: SAFE_ABI,
            functionName: "execTransaction",
            args: [
              tx.to as Address,
              tx.value,
              tx.data as Hex,
              0,
              0n,
              0n,
              0n,
              ZERO_ADDR,
              ZERO_ADDR,
              safeSig,
            ],
          });
          await gnosisPub.waitForTransactionReceipt({ hash });
          return hash;
        }

        // EOA path
        const hash = await gnosisWallet.sendTransaction({
          chain: gnosis,
          to: tx.to as Address,
          data: tx.data as Hex,
          value: tx.value,
        });
        await gnosisPub.waitForTransactionReceipt({ hash });
        return hash;
      }
    );

    bridgeTxHash = bridgeResult.originTxHash;
    console.log(`[paymentExecutor] bridge tx ${bridgeTxHash}, waiting ~90s for arrival on ${route.chain.name}...`);
    await new Promise<void>((r) => setTimeout(r, 100_000));
  }

  // ---- 5. Transfer USDC to Cryptorefills on the settlement chain -----------
  const settleTransport = http(rpcFor(route.chain.chainId));
  const settlePub = createPublicClient({ chain: settlementChain, transport: settleTransport });
  const settleWallet = createWalletClient({ account, chain: settlementChain, transport: settleTransport });

  let payTxHash: `0x${string}`;

  if (route.chain.chainId === 100 && safeAddress) {
    // Gnosis + Safe: USDC is in the Safe after the CoW swap
    const callData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [paymentAddress, paymentAmountWei],
    });
    const nonce = await settlePub.readContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "nonce",
    });
    const safeSig = await settleWallet.signTypedData({
      domain: { chainId: activeChain.id, verifyingContract: safeAddress },
      types: SAFE_TX_TYPES,
      primaryType: "SafeTx",
      message: {
        to: route.chain.usdcAddress as Address,
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
    payTxHash = await settleWallet.writeContract({
      chain: activeChain,
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "execTransaction",
      args: [
        route.chain.usdcAddress as Address,
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
    // EOA path (also used for Base/Polygon — bridge lands at the EOA)
    payTxHash = await settleWallet.writeContract({
      chain: settlementChain,
      address: route.chain.usdcAddress as Address,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [paymentAddress, paymentAmountWei],
    });
  }

  await settlePub.waitForTransactionReceipt({ hash: payTxHash });
  console.log(`[paymentExecutor] USDC sent (tx ${payTxHash}), polling for delivery...`);

  // ---- 6. Confirm DELIVERED status (code is emailed straight to the buyer) -
  const delivered = await pollForDelivery(upstreamOrderId);
  if (delivered) {
    console.log(`[paymentExecutor] ${upstreamOrderId} DELIVERED → emailed to ${params.recipientEmail}`);
  }

  return {
    upstreamOrderId,
    paymentTxHash: payTxHash,
    bridgeTxHash,
    delivered,
  };
}
