import { useEffect, useState } from "react";

// Circles mini app frontend (standalone mode).
// Embedded mode hooks into the Circles SDK for in-app passkey signing once the
// store listing is approved; until then payment is via QR / transaction URL
// opened in the Gnosis App.

interface Brand {
  brand?: string;
  brand_name?: string;
  category?: string;
  min?: string;
  max?: string;
}

interface Quote {
  id: string;
  brand: string;
  country: string;
  faceValue: number;
  priceUsdc: number;
  settlementCostUsd: number;
  serviceFeeBps: number;
  slippageBufferBps: number;
  crcTotalWei: string | null;
  usdcTotal: number;
  expiresAt: string;
}

interface OrderResp {
  orderId: string;
  status: string;
  depositAddress: string;
  crcTotalWei: string | null;
}

const COUNTRIES = ["DE", "NL", "ES", "IT", "FR", "US", "GB", "BR", "MX"];

export function App() {
  const [country, setCountry] = useState("DE");
  const [search, setSearch] = useState("");
  const [brands, setBrands] = useState<Brand[]>([]);
  const [selected, setSelected] = useState<Brand | null>(null);
  const [faceValue, setFaceValue] = useState(25);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<OrderResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setError(null);
    fetch(`/api/catalog/brands?country=${country}`)
      .then((r) => r.json())
      .then((data) => {
        // Upstream shape: { categories: [{ category, brands: [...] }, ...] }
        if (Array.isArray(data)) return setBrands(data);
        const flat = (data?.categories ?? []).flatMap(
          (c: { category?: string; brands?: Brand[] }) =>
            (c.brands ?? []).map((b) => ({ ...b, category: b.category ?? c.category })),
        );
        setBrands(flat);
      })
      .catch((e) => setError(String(e)));
  }, [country]);

  const brandName = (b: Brand) => b.brand ?? b.brand_name ?? "unknown";
  const visible = brands.filter((b) =>
    brandName(b).toLowerCase().includes(search.toLowerCase()),
  );

  async function getQuote() {
    if (!selected) return;
    setLoading(true);
    setError(null);
    setQuote(null);
    setOrder(null);
    try {
      const r = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand: brandName(selected), country, faceValue }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? r.statusText);
      setQuote(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function pay() {
    if (!quote) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteId: quote.id, payerAddress: "0xUSER" }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? r.statusText);
      setOrder(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const feePct = quote ? (quote.serviceFeeBps / 100).toFixed(2) : null;

  return (
    <div className="container">
      <header>
        <h1>🎁 Circles Gift Cards</h1>
        <p>
          Spend your CRC on gift cards & top-ups — <span className="badge">no float</span>{" "}
          auto-swap via CoW Protocol + Cryptorefills
        </p>
      </header>

      <div className="search-row">
        <select value={country} onChange={(e) => setCountry(e.target.value)}>
          {COUNTRIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input
          placeholder="Search brands…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <p className="error">{error}</p>}

      {!selected && (
        <div className="grid">
          {visible.slice(0, 30).map((b, i) => (
            <div key={i} className="card" onClick={() => setSelected(b)}>
              <h3>{brandName(b)}</h3>
              <p>{b.category ?? "gift card"}</p>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="quote-box">
          <div className="line">
            <strong>{brandName(selected)}</strong>
            <a href="#" onClick={(e) => { e.preventDefault(); setSelected(null); setQuote(null); setOrder(null); }}>
              change
            </a>
          </div>
          <div className="line">
            <span className="muted">Face value</span>
            <input
              style={{ maxWidth: 100, textAlign: "right" }}
              type="number"
              value={faceValue}
              onChange={(e) => setFaceValue(Number(e.target.value))}
            />
          </div>
          <button className="primary" onClick={getQuote} disabled={loading}>
            {loading ? "…" : "Get CRC quote"}
          </button>

          {quote && (
            <>
              <div className="line" style={{ marginTop: 12 }}>
                <span className="muted">Product price</span>
                <span>{quote.priceUsdc.toFixed(2)} USDC</span>
              </div>
              <div className="line">
                <span className="muted">Settlement cost (est.)</span>
                <span>{quote.settlementCostUsd.toFixed(2)} USDC</span>
              </div>
              <div className="line">
                <span className="muted">Service fee ({feePct}%)</span>
                <span>incl. below</span>
              </div>
              <div className="line total">
                <span>Total</span>
                <span>
                  {quote.crcTotalWei
                    ? `${(Number(quote.crcTotalWei) / 1e18).toFixed(2)} CRC`
                    : `≈ ${quote.usdcTotal.toFixed(2)} USDC in CRC`}
                </span>
              </div>
              <p className="muted" style={{ fontSize: "0.75rem" }}>
                Quote expires {new Date(quote.expiresAt).toLocaleTimeString()} — line-itemized, re-priced on expiry.
              </p>
              <button className="primary" onClick={pay} disabled={loading}>
                Pay with Circles
              </button>
            </>
          )}

          {order && (
            <>
              <p style={{ marginTop: 12 }}>
                Order <strong>{order.status}</strong>. Send the quoted CRC to:
              </p>
              <div className="deposit">{order.depositAddress}</div>
              <p className="muted" style={{ fontSize: "0.75rem" }}>
                In embedded mode this is one passkey tap in the Circles app; standalone mode
                shows a QR / transaction URL here.
              </p>
            </>
          )}
        </div>
      )}

      <footer style={{ marginTop: 24, color: "var(--muted)", fontSize: "0.75rem" }}>
        HFSP Labs · info@hfsp.xyz · hfsp.xyz
      </footer>
    </div>
  );
}
