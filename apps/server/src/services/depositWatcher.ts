// M2 skeleton: watch the orchestrator Safe on Gnosis for incoming CRC matching
// an open order's quote. Uses demurraged-balance accounting from the Circles
// SDK rather than raw transfer amounts (docs/ARCHITECTURE.md, demurrage notes).
//
// Planned implementation:
// - wss subscription (GNOSIS_RPC_WSS) to Transfer events on the configured
//   wrapped-CRC token, filtered to ORCHESTRATOR_SAFE_ADDRESS
// - match sender + amount (within demurrage tolerance) against open quotes
// - 1-block confirmation (Gnosis ~5 s), then advance the order to FUNDED
// - unmatched deposits flagged for the manual-ops refund runbook

import type { OrderState } from "./orderPipeline.js";

export function watchDeposits(_onFunded: (order: OrderState) => void): void {
  if (!process.env.GNOSIS_RPC_WSS) {
    throw new Error("GNOSIS_RPC_WSS not configured — deposit watcher is an M2 feature");
  }
  throw new Error("not implemented (M2)");
}
