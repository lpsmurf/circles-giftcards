// Order state machine (docs/ARCHITECTURE.md):
// AWAITING_DEPOSIT → FUNDED → SWAPPING → SWAPPED → PAYING → PAID → DELIVERED
// Side-exits: EXPIRED / REFUNDING → REFUNDED / FAILED

import { randomUUID } from "node:crypto";
import type { Quote } from "../routes/quote.js";
import type { PendingDeposit } from "./depositWatcher.js";
import { executeSwap, checkCowOrderFill } from "./swapExecutor.js";
import { executePayment, resumePaymentPolling } from "./paymentExecutor.js";
import { executeRefund } from "./refundExecutor.js";
import { insertOrder, updateOrder, getOrder as getOrderFromDb, getStuckOrderRows } from "../db/orderStore.js";
import type { Address } from "viem";

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
  brand: string;
  country: string;
  faceValue: number;
  status: OrderStatus;
  depositAddress: string;
  crcRequiredWei: string;
  crcReceivedWei: string | null;
  usdcNeededWei: string;
  usdcSwappedWei: string | null;
  upstreamOrderId: string | null;
  giftCardCode: string | null;
  txHashes: Record<string, string>;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

// In-memory fallback (demo mode / no DATABASE_URL).
const memOrders = new Map<string, OrderState>();
const pendingDeposits = new Map<string, PendingDeposit>();

const useDb = () => Boolean(process.env.DATABASE_URL);

async function persist(state: OrderState, isNew = false): Promise<void> {
  if (!useDb()) { memOrders.set(state.orderId, state); return; }
  if (isNew) await insertOrder(state);
  else await updateOrder(state);
}

export function getPendingDeposits(): Map<string, PendingDeposit> {
  return pendingDeposits;
}

export function startOrderPipeline(params: {
  quote: Quote;
  payerAddress: string;
}): OrderState {
  const depositAddress =
    process.env.ORCHESTRATOR_SAFE_ADDRESS ?? "0x_DEMO_MODE_no_safe_configured";

  const crcRequiredWei = params.quote.crcTotalWei ?? "0";
  const usdcNeededWei = BigInt(Math.ceil(params.quote.usdcTotal * 1e6)).toString();

  const state: OrderState = {
    orderId: randomUUID(),
    quoteId: params.quote.id,
    payerAddress: params.payerAddress,
    brand: params.quote.brand,
    country: params.quote.country,
    faceValue: params.quote.faceValue,
    status: "AWAITING_DEPOSIT",
    depositAddress,
    crcRequiredWei,
    crcReceivedWei: null,
    usdcNeededWei,
    usdcSwappedWei: null,
    upstreamOrderId: null,
    giftCardCode: null,
    txHashes: {},
    expiresAt: params.quote.expiresAt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  persist(state, true).catch((err) =>
    console.error(`[pipeline] failed to persist new order ${state.orderId}:`, err)
  );

  if (process.env.OPERATOR_KEY) {
    pendingDeposits.set(state.orderId, {
      state,
      crcRequiredWei: BigInt(crcRequiredWei),
    });
  }

  return state;
}

export function advanceToFunded(
  orderId: string,
  fromAddress: string,
  receivedWei: bigint,
  depositTxHash: string
): OrderState {
  const state = memOrders.get(orderId);
  if (!state) throw new Error(`order ${orderId} not found`);
  if (state.status !== "AWAITING_DEPOSIT") {
    throw new Error(`order ${orderId} cannot advance to FUNDED from ${state.status}`);
  }

  state.status = "FUNDED";
  state.crcReceivedWei = receivedWei.toString();
  state.txHashes.deposit = depositTxHash;
  state.updatedAt = new Date().toISOString();
  pendingDeposits.delete(orderId);

  persist(state).catch((err) =>
    console.error(`[pipeline] persist FUNDED ${orderId}:`, err)
  );

  console.log(
    `[pipeline] ${orderId} FUNDED — ${receivedWei} CRC from ${fromAddress} (tx ${depositTxHash})`
  );

  runSwap(state).catch((err) => {
    console.error(`[pipeline] swap failed for ${orderId}:`, err);
    triggerRefund(state, "pre-swap");
  });

  return state;
}

// ---- Pipeline stages -------------------------------------------------------

async function runSwap(state: OrderState): Promise<void> {
  const crcToken = process.env.CRC_TOKEN_ADDRESS;
  if (!crcToken) throw new Error("CRC_TOKEN_ADDRESS not configured");

  state.status = "SWAPPING";
  state.updatedAt = new Date().toISOString();
  await persist(state);
  console.log(`[pipeline] ${state.orderId} SWAPPING`);

  const { orderUid, fillTxHash } = await executeSwap({
    usdcNeededWei: BigInt(state.usdcNeededWei),
    crcToken: crcToken as Address,
  });

  state.usdcSwappedWei = state.usdcNeededWei;
  state.status = "SWAPPED";
  state.txHashes.cowOrderUid = orderUid;
  state.txHashes.swap = fillTxHash;
  state.updatedAt = new Date().toISOString();
  await persist(state);
  console.log(`[pipeline] ${state.orderId} SWAPPED (CoW ${orderUid}, tx ${fillTxHash})`);

  await runPayment(state).catch((err) => {
    console.error(`[pipeline] payment failed for ${state.orderId}:`, err);
    triggerRefund(state, "post-swap");
  });
}

async function runPayment(state: OrderState): Promise<void> {
  state.status = "PAYING";
  state.updatedAt = new Date().toISOString();
  await persist(state);
  console.log(`[pipeline] ${state.orderId} PAYING`);

  const result = await executePayment({
    brand: state.brand,
    country: state.country,
    faceValue: state.faceValue,
    usdcNeededWei: BigInt(state.usdcNeededWei),
  });

  state.upstreamOrderId = result.upstreamOrderId;
  state.txHashes.payment = result.paymentTxHash;
  if (result.bridgeTxHash) state.txHashes.bridge = result.bridgeTxHash;
  state.status = "PAID";
  state.updatedAt = new Date().toISOString();
  await persist(state);
  console.log(`[pipeline] ${state.orderId} PAID (upstream ${result.upstreamOrderId})`);

  if (result.giftCardCode) {
    state.status = "DELIVERED";
    state.giftCardCode = result.giftCardCode;
    state.updatedAt = new Date().toISOString();
    await persist(state);
    console.log(`[pipeline] ${state.orderId} DELIVERED`);
  }
}

// ---- Refund paths ----------------------------------------------------------

function triggerRefund(state: OrderState, stage: "pre-swap" | "post-swap"): void {
  state.status = "REFUNDING";
  state.txHashes.refundStage = stage;
  state.updatedAt = new Date().toISOString();
  persist(state).catch(() => {});
  console.log(`[pipeline] ${state.orderId} REFUNDING (${stage})`);

  if (!process.env.OPERATOR_KEY) {
    console.error(`[pipeline] ${state.orderId}: OPERATOR_KEY missing — manual refund required`);
    return;
  }

  const crcToken = process.env.CRC_TOKEN_ADDRESS;
  const usdcToken = "0x2a22f9c3b484c3629090feed35f17ff8f88f76f0"; // USDC.e on Gnosis

  let tokenAddress: string;
  let amountWei: bigint;

  if (stage === "pre-swap") {
    if (!crcToken || !state.crcReceivedWei) {
      console.error(`[pipeline] ${state.orderId}: missing CRC token/amount for refund`);
      markFailed(state);
      return;
    }
    tokenAddress = crcToken;
    amountWei = BigInt(state.crcReceivedWei);
  } else {
    if (!state.usdcSwappedWei) {
      console.error(`[pipeline] ${state.orderId}: missing USDC amount for refund`);
      markFailed(state);
      return;
    }
    tokenAddress = usdcToken;
    amountWei = BigInt(state.usdcSwappedWei);
  }

  executeRefund({
    payerAddress: state.payerAddress as `0x${string}`,
    tokenAddress: tokenAddress as `0x${string}`,
    amountWei,
    orderId: state.orderId,
  })
    .then(({ txHash }) => {
      state.status = "REFUNDED";
      state.txHashes.refund = txHash;
      state.updatedAt = new Date().toISOString();
      persist(state).catch(() => {});
      console.log(`[pipeline] ${state.orderId} REFUNDED (tx ${txHash})`);
    })
    .catch((err) => {
      console.error(`[pipeline] ${state.orderId}: refund tx failed:`, err);
      markFailed(state);
    });
}

function markFailed(state: OrderState): void {
  state.status = "FAILED";
  state.updatedAt = new Date().toISOString();
  persist(state).catch(() => {});
  console.error(`[pipeline] ${state.orderId} FAILED — manual ops required`);
}

// ---- Expiry ----------------------------------------------------------------

export function expireOrder(orderId: string): void {
  const state = memOrders.get(orderId);
  if (!state || state.status !== "AWAITING_DEPOSIT") return;
  state.status = "EXPIRED";
  state.updatedAt = new Date().toISOString();
  pendingDeposits.delete(orderId);
  persist(state).catch(() => {});
  console.log(`[pipeline] ${orderId} EXPIRED`);
}

// ---- Startup recovery (DB mode) -------------------------------------------

/** Re-hydrates AWAITING_DEPOSIT orders from DB into the in-memory maps so the
 *  deposit watcher and expiry watcher can pick them up after a server restart. */
export async function loadPendingFromDb(): Promise<void> {
  const { getPendingOrderRows } = await import("../db/orderStore.js");
  const rows = await getPendingOrderRows();
  for (const state of rows) {
    memOrders.set(state.orderId, state);
    pendingDeposits.set(state.orderId, {
      state,
      crcRequiredWei: BigInt(state.crcRequiredWei),
    });
  }
  if (rows.length > 0) {
    console.log(`[pipeline] restored ${rows.length} pending order(s) from DB`);
  }
}

// ---- Stuck order recovery --------------------------------------------------

/**
 * Called once at startup (DB mode + OPERATOR_KEY). Resumes any orders that were
 * mid-pipeline when the server last stopped. Each state has a safe retry strategy:
 *
 *  FUNDED              → re-run swap (no swap was ever submitted)
 *  SWAPPING, no uid    → rollback to FUNDED, re-run swap (POST never made it to CoW)
 *  SWAPPING, has uid   → check CoW: if filled → advance to SWAPPED; else → re-poll
 *  SWAPPED / PAYING    → re-run full payment (USDC in wallet, no Cryptorefills order)
 *  PAYING w/ upstream  → resume delivery polling (payment already sent)
 *  REFUNDING           → retry refund (idempotent by address+amount)
 */
export async function resumeStuckOrders(): Promise<void> {
  const rows = await getStuckOrderRows();
  if (rows.length === 0) return;
  console.log(`[pipeline] resuming ${rows.length} stuck order(s)...`);

  for (const state of rows) {
    memOrders.set(state.orderId, state);
    console.log(`[pipeline] resuming ${state.orderId} from ${state.status}`);

    try {
      switch (state.status) {

        case "FUNDED":
          runSwap(state).catch((err) => {
            console.error(`[pipeline] resume swap failed for ${state.orderId}:`, err);
            triggerRefund(state, "pre-swap");
          });
          break;

        case "SWAPPING": {
          const cowUid = state.txHashes.cowOrderUid;
          if (!cowUid) {
            // CoW order was never submitted — safe to restart from FUNDED
            state.status = "FUNDED";
            state.updatedAt = new Date().toISOString();
            await persist(state);
            runSwap(state).catch((err) => {
              console.error(`[pipeline] resume swap failed for ${state.orderId}:`, err);
              triggerRefund(state, "pre-swap");
            });
          } else {
            // CoW order was submitted — check if it already filled
            const fillResult = await checkCowOrderFill(cowUid).catch(() => null);
            if (!fillResult) {
              // CoW cancelled/expired — refund CRC
              triggerRefund(state, "pre-swap");
            } else if (fillResult.filled && fillResult.fillTxHash) {
              // Already filled while we were down — advance and run payment
              state.usdcSwappedWei = state.usdcNeededWei;
              state.status = "SWAPPED";
              state.txHashes.swap = fillResult.fillTxHash;
              state.updatedAt = new Date().toISOString();
              await persist(state);
              runPayment(state).catch((err) => {
                console.error(`[pipeline] resume payment failed for ${state.orderId}:`, err);
                triggerRefund(state, "post-swap");
              });
            } else {
              // Still open in CoW — re-poll until fill or timeout
              pollForFillAndContinue(state, cowUid);
            }
          }
          break;
        }

        case "SWAPPED":
          runPayment(state).catch((err) => {
            console.error(`[pipeline] resume payment failed for ${state.orderId}:`, err);
            triggerRefund(state, "post-swap");
          });
          break;

        case "PAYING":
          if (state.upstreamOrderId) {
            // Payment was sent — only need to poll for delivery
            resumePaymentPolling({ upstreamOrderId: state.upstreamOrderId }).then((code) => {
              if (code) {
                state.status = "DELIVERED";
                state.giftCardCode = code;
                state.updatedAt = new Date().toISOString();
                persist(state).catch(() => {});
                console.log(`[pipeline] ${state.orderId} DELIVERED (resumed)`);
              } else {
                console.error(`[pipeline] ${state.orderId}: no gift card code after resume poll`);
                markFailed(state);
              }
            }).catch((err) => {
              console.error(`[pipeline] resume delivery poll failed for ${state.orderId}:`, err);
              markFailed(state);
            });
          } else {
            // Cryptorefills order was never created — safe to run full payment
            runPayment(state).catch((err) => {
              console.error(`[pipeline] resume payment failed for ${state.orderId}:`, err);
              triggerRefund(state, "post-swap");
            });
          }
          break;

        case "REFUNDING":
          triggerRefund(state, (state.txHashes.refundStage as "pre-swap" | "post-swap") ?? "post-swap");
          break;

        default:
          console.warn(`[pipeline] unexpected stuck status for ${state.orderId}: ${state.status}`);
      }
    } catch (err) {
      console.error(`[pipeline] error resuming ${state.orderId}:`, err);
    }
  }
}

/** Re-poll an already-submitted CoW order and continue the pipeline when it fills. */
function pollForFillAndContinue(state: OrderState, cowUid: string): void {
  const COW_POLL_MS = 10_000;
  const COW_TIMEOUT_MS = 5 * 60_000;
  const deadline = Date.now() + COW_TIMEOUT_MS;

  const tick = async () => {
    if (Date.now() > deadline) {
      console.error(`[pipeline] ${state.orderId}: CoW order ${cowUid} timed out on resume`);
      triggerRefund(state, "pre-swap");
      return;
    }
    try {
      const r = await checkCowOrderFill(cowUid);
      if (r.filled && r.fillTxHash) {
        state.usdcSwappedWei = state.usdcNeededWei;
        state.status = "SWAPPED";
        state.txHashes.swap = r.fillTxHash;
        state.updatedAt = new Date().toISOString();
        await persist(state);
        await runPayment(state).catch((err) => {
          console.error(`[pipeline] resume payment failed for ${state.orderId}:`, err);
          triggerRefund(state, "post-swap");
        });
        return;
      }
    } catch {
      // cancelled/expired
      triggerRefund(state, "pre-swap");
      return;
    }
    setTimeout(() => { tick().catch(() => {}); }, COW_POLL_MS);
  };

  setTimeout(() => { tick().catch(() => {}); }, COW_POLL_MS);
}

// ---- Public reads ----------------------------------------------------------

export async function getPipelineState(orderId: string): Promise<OrderState | undefined> {
  if (useDb()) {
    const row = await getOrderFromDb(orderId);
    return row ?? undefined;
  }
  return memOrders.get(orderId);
}
