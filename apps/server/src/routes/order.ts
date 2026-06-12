import { Router } from "express";
import { getOrderStatus, validateOrder } from "@circles-giftcards/cryptorefills-client";
import { quotes } from "./quote.js";
import { startOrderPipeline, getPipelineState } from "../services/orderPipeline.js";

export const orderRouter = Router();

// Begin an order from an unexpired quote. In demo mode (no OPERATOR_KEY) this
// validates upstream and returns the deposit instructions without executing.
orderRouter.post("/", async (req, res) => {
  try {
    const { quoteId, payerAddress, recipientEmail } = req.body as {
      quoteId: string;
      payerAddress: string;
      recipientEmail?: string;
    };
    const quote = quotes.get(quoteId);
    if (!quote) return res.status(404).json({ error: "quote not found" });
    if (new Date(quote.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ error: "quote expired — request a new one" });
    }

    const validation = await validateOrder({
      brand_name: quote.brand,
      country_code: quote.country,
      face_value: quote.faceValue,
      coin: "USDC",
      ...(recipientEmail ? { email: recipientEmail } : {}),
    });

    const state = startOrderPipeline({ quote, payerAddress });
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
  const state = getPipelineState(req.params.id);
  if (!state) return res.status(404).json({ error: "order not found" });
  let upstream: unknown = null;
  if (state.upstreamOrderId) {
    try {
      upstream = await getOrderStatus(state.upstreamOrderId);
    } catch {
      upstream = { error: "upstream status unavailable" };
    }
  }
  res.json({ ...state, upstream });
});
