import { getPendingDeposits, expireOrder } from "./orderPipeline.js";

const CHECK_INTERVAL_MS = 30_000;

export function startExpiryWatcher(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [orderId, { state }] of getPendingDeposits()) {
      if (state.expiresAt && new Date(state.expiresAt).getTime() < now) {
        console.log(`[expiryWatcher] expiring order ${orderId}`);
        expireOrder(orderId);
      }
    }
  }, CHECK_INTERVAL_MS);
}
