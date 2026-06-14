import express from "express";
import cors from "cors";
import { catalogRouter } from "./routes/catalog.js";
import { quoteRouter } from "./routes/quote.js";
import { orderRouter } from "./routes/order.js";
import { healthRouter, adminRouter } from "./routes/health.js";
import { watchDeposits } from "./services/depositWatcher.js";
import { getPendingDeposits, advanceToFunded, loadPendingFromDb, resumeStuckOrders } from "./services/orderPipeline.js";
import { startExpiryWatcher } from "./services/expiryWatcher.js";
import { runMigrations } from "./db/pool.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/health", healthRouter);
app.use("/api/admin", adminRouter);
app.use("/api/catalog", catalogRouter);
app.use("/api/quote", quoteRouter);
app.use("/api/order", orderRouter);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, async () => {
  console.log(`[server] listening on :${port}`);
  console.log(`[server] catalog/quote endpoints work with no keys (public APIs)`);

  if (process.env.DATABASE_URL) {
    await runMigrations();
  }

  if (!process.env.OPERATOR_KEY) {
    console.log(`[server] execution pipeline DISABLED (no OPERATOR_KEY) — demo mode`);
    return;
  }

  console.log(`[server] execution mode — starting deposit watcher`);

  if (process.env.DATABASE_URL) {
    await loadPendingFromDb();
    await resumeStuckOrders();
  }

  startExpiryWatcher();

  watchDeposits(
    getPendingDeposits,
    // onFunded: CRC arrived and matched an open order
    (order, fromAddress, receivedWei, txHash) => {
      try {
        advanceToFunded(order.orderId, fromAddress, receivedWei, txHash);
      } catch (err) {
        console.error(`[server] advanceToFunded failed for ${order.orderId}:`, err);
      }
    },
    // onUnmatched: deposit has no matching open order — needs manual ops
    (fromAddress, value, txHash) => {
      console.error(
        `[server] UNMATCHED DEPOSIT — add to ops runbook: from=${fromAddress} value=${value} tx=${txHash}`
      );
    }
  );
});
