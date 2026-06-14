import pg from "pg";

const { Pool } = pg;

// Lazily created — only initialised when DATABASE_URL is set (execution mode).
let _pool: InstanceType<typeof Pool> | null = null;

export function getPool(): InstanceType<typeof Pool> {
  if (!_pool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not configured");
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

/** Convenience wrapper for single-statement queries. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  values?: unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(sql, values);
}

/**
 * Create tables if they don't exist. Safe to call on every startup — all
 * statements use IF NOT EXISTS / DO NOTHING.
 */
export async function runMigrations(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS quotes (
      id             UUID        PRIMARY KEY,
      brand          TEXT        NOT NULL,
      country        TEXT        NOT NULL,
      face_value     NUMERIC     NOT NULL,
      price_usdc     NUMERIC     NOT NULL,
      settlement_cost_usd NUMERIC NOT NULL,
      service_fee_bps     INT    NOT NULL,
      slippage_buffer_bps INT    NOT NULL,
      crc_token_address   TEXT,
      crc_total_wei       TEXT,
      usdc_total          NUMERIC NOT NULL,
      expires_at          TIMESTAMPTZ NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id            UUID        PRIMARY KEY,
      quote_id            UUID        NOT NULL,
      payer_address       TEXT        NOT NULL,
      brand               TEXT        NOT NULL,
      country             TEXT        NOT NULL,
      face_value          NUMERIC     NOT NULL,
      status              TEXT        NOT NULL,
      deposit_address     TEXT        NOT NULL,
      crc_required_wei    TEXT        NOT NULL,
      crc_received_wei    TEXT,
      usdc_needed_wei     TEXT        NOT NULL,
      usdc_swapped_wei    TEXT,
      upstream_order_id   TEXT,
      gift_card_code      TEXT,
      tx_hashes           JSONB       NOT NULL DEFAULT '{}',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Safe add-column for schemas created before expires_at was added
  await query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  `);

  // Fast lookups for the deposit watcher (AWAITING_DEPOSIT orders)
  await query(`
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)
    WHERE status = 'AWAITING_DEPOSIT'
  `);

  console.log("[db] migrations OK");
}
