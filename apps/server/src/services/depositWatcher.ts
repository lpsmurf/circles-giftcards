import { createPublicClient, webSocket, parseAbiItem, type Address } from "viem";
import type { OrderState } from "./orderPipeline.js";
import { activeChain, activeRpcWss } from "../config/network.js";

// ── Liveness state ────────────────────────────────────────
let _startedAtMs: number | null = null;
let _lastEventAtMs: number | null = null;

export function getWatcherLiveness() {
  return {
    running: _startedAtMs !== null,
    startedAtMs: _startedAtMs,
    lastEventAtMs: _lastEventAtMs,
  };
}

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

// Allow received amount to be up to 0.5% below the quoted requirement.
// CRC demurrage within a 90-second quote window is ~0.0002%, so 0.5% is
// generous enough to absorb rounding in different CRC wrapper implementations.
const TOLERANCE_BPS = 50n;

export interface PendingDeposit {
  state: OrderState;
  crcRequiredWei: bigint;
}

export type FundedCallback = (
  order: OrderState,
  fromAddress: Address,
  receivedWei: bigint,
  txHash: `0x${string}`
) => void;

export type UnmatchedCallback = (
  fromAddress: Address,
  value: bigint,
  txHash: `0x${string}`
) => void;

/**
 * Subscribe to incoming CRC transfers to the orchestrator Safe on Gnosis.
 * Matches each deposit against the pending-orders map and fires onFunded
 * for the first order whose required amount is satisfied.
 * Unmatched deposits (no open order with a matching amount) are handed to
 * onUnmatched for the manual-ops refund runbook.
 *
 * Returns an unwatch function — call it to cancel the subscription cleanly.
 */
export function watchDeposits(
  getPendingOrders: () => Map<string, PendingDeposit>,
  onFunded: FundedCallback,
  onUnmatched: UnmatchedCallback
): () => void {
  const rpcUrl = activeRpcWss();
  const crcToken = process.env.CRC_TOKEN_ADDRESS;
  const safeAddress = process.env.ORCHESTRATOR_SAFE_ADDRESS;

  if (!rpcUrl) throw new Error("GNOSIS_RPC_WSS / CHIADO_RPC_WSS not configured");
  if (!crcToken) throw new Error("CRC_TOKEN_ADDRESS not configured");
  if (!safeAddress) throw new Error("ORCHESTRATOR_SAFE_ADDRESS not configured");

  const client = createPublicClient({
    chain: activeChain,
    transport: webSocket(rpcUrl, { reconnect: { delay: 2000, attempts: 10 } }),
  });

  _startedAtMs = Date.now();
  console.log("[depositWatcher] subscribing to CRC transfers → Safe on Gnosis");

  const unwatch = client.watchContractEvent({
    address: crcToken as Address,
    abi: [TRANSFER_EVENT],
    eventName: "Transfer",
    args: { to: safeAddress as Address },
    onLogs: (logs) => {
      for (const log of logs) {
        const { from, value } = log.args as { from: Address; value: bigint };
        const txHash = log.transactionHash ?? ("0x" as `0x${string}`);

        _lastEventAtMs = Date.now();
        console.log(
          `[depositWatcher] incoming CRC from=${from} value=${value} tx=${txHash}`
        );

        const pending = getPendingOrders();
        let matched = false;

        for (const [orderId, { state, crcRequiredWei }] of pending) {
          const minAcceptable =
            crcRequiredWei - (crcRequiredWei * TOLERANCE_BPS) / 10_000n;

          if (value >= minAcceptable) {
            console.log(`[depositWatcher] matched → order ${orderId}`);
            onFunded(state, from, value, txHash);
            matched = true;
            break; // one deposit funds one order
          }
        }

        if (!matched) {
          console.warn(
            `[depositWatcher] unmatched deposit from=${from} value=${value} tx=${txHash}`
          );
          onUnmatched(from, value, txHash);
        }
      }
    },
    onError: (err) => {
      console.error("[depositWatcher] subscription error:", err);
    },
  });

  return unwatch;
}
