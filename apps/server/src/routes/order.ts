import { Router, type Request } from "express";
import { getOrderStatus, validateOrder } from "@circles-giftcards/cryptorefills-client";
import { quotes } from "./quote.js";
import { getQuote as getQuoteFromDb } from "../db/quoteStore.js";
import { startOrderPipeline, getPipelineState } from "../services/orderPipeline.js";

export const orderRouter = Router();

// ── Rate limiting (POST /api/order) ───────────────────────────────────────────
// Sliding window: MAX_ORDERS_PER_WINDOW orders per IP within WINDOW_MS.
const WINDOW_MS = 10 * 60_000;  // 10 minutes
const MAX_ORDERS = 5;
const ipWindows = new Map<string, number[]>();

function isRateLimited(req: Request): boolean {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim()
    ?? req.socket.remoteAddress
    ?? "unknown";
  const now = Date.now();
  const timestamps = (ipWindows.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length >= MAX_ORDERS) return true;
  timestamps.push(now);
  ipWindows.set(ip, timestamps);
  // Evict old entries every hour to avoid unbounded growth
  if (ipWindows.size > 10_000) {
    for (const [k, v] of ipWindows) {
      if (v.every((t) => now - t >= WINDOW_MS)) ipWindows.delete(k);
    }
  }
  return false;
}

async function resolveQuote(quoteId: string) {
  if (quotes.has(quoteId)) return quotes.get(quoteId);
  if (process.env.DATABASE_URL) return (await getQuoteFromDb(quoteId)) ?? undefined;
  return undefined;
}

orderRouter.post("/", async (req, res) => {
  if (isRateLimited(req)) {
    return res.status(429).json({
      error: `too many orders — max ${MAX_ORDERS} per ${WINDOW_MS / 60_000} minutes`,
    });
  }
  try {
    const { quoteId, payerAddress, recipientEmail } = req.body as {
      quoteId: string;
      payerAddress: string;
      recipientEmail?: string;
    };

    // The gift card code is emailed by Cryptorefills directly to the buyer, so a
    // valid delivery email is required (NON-CUSTODIAL CODE POLICY).
    const email = (recipientEmail ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "a valid recipientEmail is required for delivery" });
    }

    const quote = await resolveQuote(quoteId);
    if (!quote) return res.status(404).json({ error: "quote not found" });
    if (new Date(quote.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ error: "quote expired — request a new one" });
    }

    // Best-effort upstream pre-validation. Some brands' MCP catalog entries list
    // only BTC even though they accept stablecoin checkout, so a coin-specific
    // validation failure must not block the order — settlement coin is resolved
    // later in the pipeline.
    let validation: unknown = null;
    for (const coin of ["USDC", "USDT"]) {
      try {
        validation = await validateOrder({
          brand_name: quote.brand,
          country_code: quote.country,
          face_value: quote.faceValue,
          coin,
          email,
        });
        break;
      } catch {
        // try next coin; non-fatal
      }
    }

    const state = startOrderPipeline({ quote, payerAddress, recipientEmail: email });
    res.json({
      orderId: state.orderId,
      status: state.status,
      depositAddress: state.depositAddress,
      crcTotalWei: quote.crcTotalWei,
      expiresAt: quote.expiresAt,
      upstreamValidation: validation,
    });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

orderRouter.get("/:id", async (req, res) => {
  const state = await getPipelineState(req.params.id);
  if (!state) return res.status(404).json({ error: "order not found" });

  // Strip gift card code from the response — served separately once DELIVERED
  // to allow future encryption / show-once semantics.
  const { giftCardCode, ...publicState } = state;
  let giftCard: { code: string } | null = null;
  if (state.status === "DELIVERED" && giftCardCode) {
    giftCard = { code: giftCardCode };
  }

  let upstream: unknown = null;
  if (state.upstreamOrderId) {
    try {
      upstream = await getOrderStatus(state.upstreamOrderId);
    } catch {
      upstream = { error: "upstream status unavailable" };
    }
  }

  res.json({ ...publicState, giftCard, upstream });
});
