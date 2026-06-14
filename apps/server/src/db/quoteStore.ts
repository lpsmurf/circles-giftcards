import { query } from "./pool.js";
import type { Quote } from "../routes/quote.js";

export async function saveQuote(q: Quote): Promise<void> {
  await query(
    `INSERT INTO quotes
       (id, brand, country, face_value, price_usdc, settlement_cost_usd,
        service_fee_bps, slippage_buffer_bps, crc_token_address,
        crc_total_wei, usdc_total, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO NOTHING`,
    [
      q.id,
      q.brand,
      q.country,
      q.faceValue,
      q.priceUsdc,
      q.settlementCostUsd,
      q.serviceFeeBps,
      q.slippageBufferBps,
      q.crcTokenAddress,
      q.crcTotalWei,
      q.usdcTotal,
      q.expiresAt,
    ]
  );
}

export async function getQuote(id: string): Promise<Quote | null> {
  const res = await query<{
    id: string;
    brand: string;
    country: string;
    face_value: string;
    price_usdc: string;
    settlement_cost_usd: string;
    service_fee_bps: number;
    slippage_buffer_bps: number;
    crc_token_address: string | null;
    crc_total_wei: string | null;
    usdc_total: string;
    expires_at: string;
  }>("SELECT * FROM quotes WHERE id = $1", [id]);

  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    brand: r.brand,
    country: r.country,
    faceValue: Number(r.face_value),
    priceUsdc: Number(r.price_usdc),
    settlementCostUsd: Number(r.settlement_cost_usd),
    serviceFeeBps: r.service_fee_bps,
    slippageBufferBps: r.slippage_buffer_bps,
    crcTokenAddress: r.crc_token_address,
    crcTotalWei: r.crc_total_wei,
    usdcTotal: Number(r.usdc_total),
    expiresAt: r.expires_at,
  };
}
