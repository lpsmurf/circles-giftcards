import { query } from "./pool.js";
import { decryptCode } from "./crypto.js";
import type { OrderState } from "../services/orderPipeline.js";

// NON-CUSTODIAL CODE POLICY: gift card codes are delivered by Cryptorefills
// directly to the buyer's email. The orchestrator never receives or stores a
// code, so gift_card_code is always written as NULL. The column and the
// decrypt-on-read are retained only so any legacy encrypted rows remain
// readable during migration.

// Columns that change on every update — everything except order_id / created_at.
const UPDATE_COLS = [
  "status",
  "crc_received_wei",
  "usdc_swapped_wei",
  "upstream_order_id",
  "gift_card_code",
  "tx_hashes",
  "updated_at",
] as const;

function toRow(s: OrderState) {
  return {
    order_id: s.orderId,
    quote_id: s.quoteId,
    payer_address: s.payerAddress,
    brand: s.brand,
    country: s.country,
    face_value: s.faceValue,
    status: s.status,
    deposit_address: s.depositAddress,
    crc_required_wei: s.crcRequiredWei,
    crc_received_wei: s.crcReceivedWei,
    usdc_needed_wei: s.usdcNeededWei,
    usdc_swapped_wei: s.usdcSwappedWei,
    upstream_order_id: s.upstreamOrderId,
    gift_card_code: null, // never stored — see NON-CUSTODIAL CODE POLICY above
    recipient_email: s.recipientEmail,
    tx_hashes: JSON.stringify(s.txHashes),
    expires_at: s.expiresAt,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

function fromRow(r: Record<string, unknown>): OrderState {
  return {
    orderId: r.order_id as string,
    quoteId: r.quote_id as string,
    payerAddress: r.payer_address as string,
    brand: r.brand as string,
    country: r.country as string,
    faceValue: Number(r.face_value),
    status: r.status as OrderState["status"],
    depositAddress: r.deposit_address as string,
    crcRequiredWei: r.crc_required_wei as string,
    crcReceivedWei: (r.crc_received_wei as string | null) ?? null,
    usdcNeededWei: r.usdc_needed_wei as string,
    usdcSwappedWei: (r.usdc_swapped_wei as string | null) ?? null,
    upstreamOrderId: (r.upstream_order_id as string | null) ?? null,
    recipientEmail: (r.recipient_email as string | null) ?? "",
    giftCardCode: r.gift_card_code ? decryptCode(r.gift_card_code as string) : null,
    txHashes:
      typeof r.tx_hashes === "string"
        ? (JSON.parse(r.tx_hashes) as Record<string, string>)
        : (r.tx_hashes as Record<string, string>),
    expiresAt: r.expires_at as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function insertOrder(s: OrderState): Promise<void> {
  const r = toRow(s);
  await query(
    `INSERT INTO orders
       (order_id, quote_id, payer_address, brand, country, face_value,
        status, deposit_address, crc_required_wei, crc_received_wei,
        usdc_needed_wei, usdc_swapped_wei, upstream_order_id,
        gift_card_code, recipient_email, tx_hashes, expires_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (order_id) DO NOTHING`,
    [
      r.order_id, r.quote_id, r.payer_address, r.brand, r.country,
      r.face_value, r.status, r.deposit_address, r.crc_required_wei,
      r.crc_received_wei, r.usdc_needed_wei, r.usdc_swapped_wei,
      r.upstream_order_id, r.gift_card_code, r.recipient_email, r.tx_hashes,
      r.expires_at, r.created_at, r.updated_at,
    ]
  );
}

export async function updateOrder(s: OrderState): Promise<void> {
  await query(
    `UPDATE orders SET
       status            = $2,
       crc_received_wei  = $3,
       usdc_swapped_wei  = $4,
       upstream_order_id = $5,
       gift_card_code    = $6,
       tx_hashes         = $7,
       updated_at        = $8
     WHERE order_id = $1`,
    [
      s.orderId,
      s.status,
      s.crcReceivedWei,
      s.usdcSwappedWei,
      s.upstreamOrderId,
      null, // gift_card_code — never stored (NON-CUSTODIAL CODE POLICY)
      JSON.stringify(s.txHashes),
      s.updatedAt,
    ]
  );
}

export async function getOrder(orderId: string): Promise<OrderState | null> {
  const res = await query("SELECT * FROM orders WHERE order_id = $1", [orderId]);
  if (res.rowCount === 0) return null;
  return fromRow(res.rows[0] as Record<string, unknown>);
}

/** Returns all orders in AWAITING_DEPOSIT for the deposit watcher. */
export async function getPendingOrderRows(): Promise<OrderState[]> {
  const res = await query(
    "SELECT * FROM orders WHERE status = 'AWAITING_DEPOSIT'"
  );
  return res.rows.map((r) => fromRow(r as Record<string, unknown>));
}

/** Returns orders in mid-pipeline states that need to be resumed after a restart. */
export async function getStuckOrderRows(): Promise<OrderState[]> {
  const res = await query(
    `SELECT * FROM orders WHERE status IN ('FUNDED','SWAPPING','SWAPPED','PAYING','REFUNDING')
     ORDER BY created_at ASC`
  );
  return res.rows.map((r) => fromRow(r as Record<string, unknown>));
}

// Columns used — satisfies the linter (unused import guard).
void UPDATE_COLS;
