import { Router } from "express";
import { randomUUID } from "node:crypto";
import { getProductPrice } from "@circles-giftcards/cryptorefills-client";
import { quoteSellForExactBuy } from "@circles-giftcards/swap-router";
import { saveQuote, getQuote as getQuoteFromDb } from "../db/quoteStore.js";

// Quote math (docs/SWAP-ROUTING.md):
//   CRC_total = cowQuote(USDC_out = P + B) × (1 + slippage) × (1 + serviceFee)
// B (settlement cost) uses a flat conservative estimate in demo mode; M2 wires
// the live chainSelector.

const SERVICE_FEE_BPS = Number(process.env.SERVICE_FEE_BPS ?? 200);
const SLIPPAGE_BUFFER_BPS = Number(process.env.SLIPPAGE_BUFFER_BPS ?? 100);
const QUOTE_TTL_SECONDS = Number(process.env.QUOTE_TTL_SECONDS ?? 90);
const SETTLEMENT_COST_USD_ESTIMATE = 0.15;

export interface Quote {
  id: string;
  brand: string;
  country: string;
  faceValue: number;
  priceUsdc: number;
  settlementCostUsd: number;
  serviceFeeBps: number;
  slippageBufferBps: number;
  crcTokenAddress: string | null;
  crcTotalWei: string | null; // null when CRC_TOKEN_ADDRESS unset (demo mode)
  usdcTotal: number;
  expiresAt: string;
}

// In-memory fallback (demo mode / no DATABASE_URL).
const memQuotes = new Map<string, Quote>();

async function storeQuote(q: Quote): Promise<void> {
  memQuotes.set(q.id, q);
  if (process.env.DATABASE_URL) await saveQuote(q);
}

async function lookupQuote(id: string): Promise<Quote | undefined> {
  if (memQuotes.has(id)) return memQuotes.get(id);
  if (process.env.DATABASE_URL) return (await getQuoteFromDb(id)) ?? undefined;
  return undefined;
}

// Keep exporting `quotes` for order.ts compatibility (reads the in-memory map).
export const quotes = memQuotes;

export const quoteRouter = Router();

quoteRouter.post("/", async (req, res) => {
  try {
    const { brand, country, faceValue } = req.body as {
      brand: string;
      country: string;
      faceValue: number;
    };
    if (!brand || !country || !faceValue) {
      return res.status(400).json({ error: "brand, country, faceValue required" });
    }

    // Try USDC first (direct 1:1 with USD); fall back to USDT (also 1:1); fall back
    // to face_value for brands whose MCP catalog entry only lists BTC even though
    // they accept stablecoin payment via USER_WALLET checkout.
    let priceUsdc: number = NaN;
    for (const coin of ["USDC", "USDT"]) {
      try {
        const priceResp = (await getProductPrice({
          brand_name: brand,
          country_code: country.toUpperCase(),
          face_value: faceValue,
          coin,
        })) as Record<string, unknown>;
        const amount = Number((priceResp as { coin_amount?: string }).coin_amount ?? NaN);
        if (Number.isFinite(amount)) {
          priceUsdc = amount;
          break;
        }
      } catch {
        // try next coin
      }
    }
    // Last resort: use face_value directly as USD approximation (close for USD-
    // denominated cards; may be ~5-10% off for EUR/GBP cards due to FX).
    if (!Number.isFinite(priceUsdc)) {
      priceUsdc = faceValue;
    }

    const usdcNeeded = priceUsdc + SETTLEMENT_COST_USD_ESTIMATE;
    const usdcTotal =
      usdcNeeded * (1 + SLIPPAGE_BUFFER_BPS / 10_000) * (1 + SERVICE_FEE_BPS / 10_000);

    // CRC leg: only quotable when a liquid wrapped-CRC token is configured.
    const crcToken = process.env.CRC_TOKEN_ADDRESS || null;
    let crcTotalWei: string | null = null;
    if (crcToken) {
      const operator = process.env.ORCHESTRATOR_SAFE_ADDRESS || "0x0000000000000000000000000000000000000001";
      const cow = await quoteSellForExactBuy({
        sellToken: crcToken,
        buyAmountWei: BigInt(Math.ceil(usdcNeeded * 1e6)),
        receiver: operator,
        from: operator,
      });
      const buffered =
        (cow.sellAmount * BigInt(10_000 + SLIPPAGE_BUFFER_BPS) * BigInt(10_000 + SERVICE_FEE_BPS)) /
        BigInt(10_000 * 10_000);
      crcTotalWei = buffered.toString();
    }

    const quote: Quote = {
      id: randomUUID(),
      brand,
      country: country.toUpperCase(),
      faceValue,
      priceUsdc,
      settlementCostUsd: SETTLEMENT_COST_USD_ESTIMATE,
      serviceFeeBps: SERVICE_FEE_BPS,
      slippageBufferBps: SLIPPAGE_BUFFER_BPS,
      crcTokenAddress: crcToken,
      crcTotalWei,
      usdcTotal: Math.round(usdcTotal * 100) / 100,
      expiresAt: new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString(),
    };
    await storeQuote(quote);
    res.json(quote);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

quoteRouter.get("/:id", async (req, res) => {
  const q = await lookupQuote(req.params.id);
  if (!q) return res.status(404).json({ error: "quote not found" });
  res.json(q);
});
