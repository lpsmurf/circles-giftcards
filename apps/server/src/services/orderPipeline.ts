// Order state machine (docs/ARCHITECTURE.md):
// QUOTED → FUNDED → SWAPPED → SETTLED → PAID → DELIVERED
// with EXPIRED / REFUNDING / REFUNDED side-exits at each stage.
//
// Demo mode (no OPERATOR_KEY): orders stay in AWAITING_DEPOSIT and the watcher
// is not started. M2 wires the deposit watcher, CoW execution, chain selection,
// x402 payment and a Postgres ledger behind these same interfaces.

import { randomUUID } from "node:crypto";
import type { Quote } from "../routes/quote.js";

export type OrderStatus =
  | "AWAITING_DEPOSIT"
  | "FUNDED"
  | "SWAPPING"
  | "SWAPPED"
  | "BRIDGING"
  | "SETTLED"
  | "PAYING"
  | "PAID"
  | "DELIVERED"
  | "EXPIRED"
  | "REFUNDING"
  | "REFUNDED"
  | "FAILED";

export interface OrderState {
  orderId: string;
  quoteId: string;
  payerAddress: string;
  status: OrderStatus;
  depositAddress: string;
  upstreamOrderId: string | null;
  txHashes: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

const orders = new Map<string, OrderState>();

export function startOrderPipeline(params: { quote: Quote; payerAddress: string }): OrderState {
  const depositAddress =
    process.env.ORCHESTRATOR_SAFE_ADDRESS ?? "0x_DEMO_MODE_no_safe_configured";
  const state: OrderState = {
    orderId: randomUUID(),
    quoteId: params.quote.id,
    payerAddress: params.payerAddress,
    status: "AWAITING_DEPOSIT",
    depositAddress,
    upstreamOrderId: null,
    txHashes: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  orders.set(state.orderId, state);

  if (process.env.OPERATOR_KEY) {
    // M2: depositWatcher.watch(state) → on CRC received: swap → route → pay.
    throw new Error("execution pipeline not implemented yet (M2) — unset OPERATOR_KEY for demo mode");
  }
  return state;
}

export function getPipelineState(orderId: string): OrderState | undefined {
  return orders.get(orderId);
}
