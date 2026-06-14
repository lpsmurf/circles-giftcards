import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

interface Brand {
  brand?: string;
  brand_name?: string;
  category?: string;
  min?: string;
  max?: string;
}

interface ProductInfo {
  currency: string;
  isRange: boolean;
  min?: number;
  max?: number;
  step?: number;
  denominations?: number[];
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

interface LiveOrder {
  orderId: string;
  status: string;
  depositAddress: string;
  crcRequiredWei: string;
  expiresAt: string;
  giftCard: { code: string } | null;
  txHashes: Record<string, string>;
}

const COUNTRIES = ["DE", "NL", "ES", "IT", "FR", "US", "GB", "BR", "MX"];
const TERMINAL = new Set(["DELIVERED", "REFUNDED", "FAILED", "EXPIRED"]);
const STEPS = [
  { key: "deposit", label: "Deposit",   statuses: ["AWAITING_DEPOSIT"] },
  { key: "swap",    label: "Swap",      statuses: ["FUNDED", "SWAPPING", "SWAPPED"] },
  { key: "pay",     label: "Pay",       statuses: ["PAYING", "PAID"] },
  { key: "done",    label: "Gift card", statuses: ["DELIVERED"] },
];

function stepIndex(status: string): number {
  return STEPS.findIndex((s) => s.statuses.includes(status));
}

// ── Parse Cryptorefills product response into a simple ProductInfo ────────────
function parseProductInfo(data: unknown): ProductInfo | null {
  const items = Array.isArray(data) ? data : [data];
  const brandItem = items[0] as Record<string, unknown> | undefined;
  if (!brandItem) return null;

  const products = (brandItem.products ?? []) as Array<Record<string, unknown>>;
  if (!products.length) return null;

  // Prefer USDC products; fall back to any.
  const usdc = products.filter((p) => p.coin === "USDC" || p.payment_method === "USDC");
  const pool = usdc.length ? usdc : products;
  const sample = pool[0];

  if (sample.is_dynamic) {
    const range = sample.range as Record<string, number> | null;
    if (!range) return null;
    return {
      currency: range.currency as unknown as string,
      isRange: true,
      min: range.min,
      max: range.max,
      step: range.step_size ?? 1,
    };
  }

  // Fixed denominations — collect unique amounts across all pool products.
  const seen = new Set<number>();
  const denominations: number[] = [];
  for (const p of pool) {
    const fv = p.face_value as Record<string, unknown> | undefined;
    const amount = fv?.amount as Record<string, unknown> | undefined;
    const price = parseFloat(String(amount?.price ?? ""));
    if (!isNaN(price) && !seen.has(price)) {
      seen.add(price);
      denominations.push(price);
    }
  }
  denominations.sort((a, b) => a - b);

  const currency =
    (sample.face_value as Record<string, unknown> | undefined)
      ?.currency_code as string ?? "";

  return { currency, isRange: false, denominations };
}

// ── Small components ──────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "✓" : "Copy"}
    </button>
  );
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [secs, setSecs] = useState(() =>
    Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
  );
  useEffect(() => {
    if (secs <= 0) return;
    const id = setInterval(() => setSecs((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [secs]);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return (
    <span className={secs <= 30 ? "countdown urgent" : "countdown"}>
      {m}:{s.toString().padStart(2, "0")}
    </span>
  );
}

function StatusSteps({ status }: { status: string }) {
  const current = stepIndex(status);
  if (current === -1) return null;
  return (
    <div className="status-steps">
      {STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={step.key} className={`step${done ? " done" : ""}${active ? " active" : ""}`}>
            <div className="step-dot">{done ? "✓" : i + 1}</div>
            <div className="step-label">{step.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

export function App() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [country, setCountry] = useState("DE");
  const [search, setSearch] = useState("");
  const [brands, setBrands] = useState<Brand[]>([]);
  const [selected, setSelected] = useState<Brand | null>(null);
  const [productInfo, setProductInfo] = useState<ProductInfo | null>(null);
  const [productLoading, setProductLoading] = useState(false);
  const [faceValue, setFaceValue] = useState(25);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<LiveOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-reconnect if wallet was previously connected.
  useEffect(() => {
    if (!window.ethereum) return;
    window.ethereum.request({ method: "eth_accounts" }).then((accounts) => {
      const list = accounts as string[];
      if (list[0]) setWalletAddress(list[0]);
    }).catch(() => {});
    const handler = (accounts: unknown) => {
      const list = accounts as string[];
      setWalletAddress(list[0] ?? null);
    };
    window.ethereum.on("accountsChanged", handler);
    return () => window.ethereum?.removeListener("accountsChanged", handler);
  }, []);

  async function connectWallet() {
    if (!window.ethereum) {
      setError("No wallet detected — install MetaMask or open inside Circles app.");
      return;
    }
    setWalletConnecting(true);
    setError(null);
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
      setWalletAddress(accounts[0] ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setWalletConnecting(false);
    }
  }

  // Load brand list when country changes.
  useEffect(() => {
    setError(null);
    fetch(`/api/catalog/brands?country=${country}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) return setBrands(data);
        const flat = (data?.categories ?? []).flatMap(
          (c: { category?: string; brands?: Brand[] }) =>
            (c.brands ?? []).map((b) => ({ ...b, category: b.category ?? c.category }))
        );
        setBrands(flat);
      })
      .catch((e) => setError(String(e)));
  }, [country]);

  // Fetch product info (range / denominations) when brand or country changes.
  useEffect(() => {
    if (!selected) { setProductInfo(null); return; }
    setProductInfo(null);
    setProductLoading(true);
    setQuote(null);
    const name = brandName(selected);
    fetch(`/api/catalog/products?country=${country}&brand=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((data) => {
        const info = parseProductInfo(data);
        setProductInfo(info);
        if (info) {
          if (info.isRange && info.min != null) {
            setFaceValue(info.min);
          } else if (!info.isRange && info.denominations?.length) {
            setFaceValue(info.denominations[0]);
          }
        }
      })
      .catch(() => setProductInfo(null))
      .finally(() => setProductLoading(false));
  }, [selected, country]);

  // Stop polling on unmount.
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const startPolling = useCallback((orderId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/order/${orderId}`);
        if (!r.ok) return;
        const data = (await r.json()) as LiveOrder;
        setOrder(data);
        if (TERMINAL.has(data.status)) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
        }
      } catch { /* keep polling */ }
    }, 5_000);
  }, []);

  const brandName = (b: Brand) => b.brand ?? b.brand_name ?? "unknown";
  const visible = brands.filter((b) =>
    brandName(b).toLowerCase().includes(search.toLowerCase())
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
    if (!walletAddress) {
      setError("Please connect your wallet first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteId: quote.id, payerAddress: walletAddress }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? r.statusText);
      const live: LiveOrder = {
        orderId: data.orderId,
        status: data.status,
        depositAddress: data.depositAddress,
        crcRequiredWei: quote.crcTotalWei ?? "0",
        expiresAt: data.expiresAt ?? quote.expiresAt,
        giftCard: null,
        txHashes: {},
      };
      setOrder(live);
      startPolling(data.orderId);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setSelected(null);
    setQuote(null);
    setOrder(null);
    setError(null);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  const feePct = quote ? (quote.serviceFeeBps / 100).toFixed(2) : null;
  const crcDisplay = (wei: string) => (Number(wei) / 1e18).toFixed(4);
  const cur = productInfo?.currency ?? "";

  return (
    <div className="container">
      <header>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>🎁 Circles Gift Cards</h1>
          {walletAddress ? (
            <span className="wallet-chip" title={walletAddress}>
              {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
            </span>
          ) : (
            <button className="wallet-btn" onClick={connectWallet} disabled={walletConnecting}>
              {walletConnecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
        <p style={{ color: "var(--muted)", margin: "4px 0 0", fontSize: "0.9rem" }}>
          Spend your CRC on gift cards &amp; top-ups —{" "}
          <span className="badge">no float</span> auto-swap via CoW Protocol + Cryptorefills
        </p>
      </header>

      <div className="search-row">
        <select value={country} onChange={(e) => { setCountry(e.target.value); setSelected(null); }}>
          {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
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
            <div key={i} className="card" onClick={() => { setSelected(b); setSearch(""); }}>
              <h3>{brandName(b)}</h3>
              <p>{b.category ?? "gift card"}</p>
            </div>
          ))}
        </div>
      )}

      {selected && !order && (
        <div className="quote-box">
          <div className="line">
            <strong>{brandName(selected)}</strong>
            <a href="#" onClick={(e) => { e.preventDefault(); reset(); }}>change</a>
          </div>

          {/* ── Face value selector ─────────────────────────── */}
          {productLoading && (
            <p className="muted" style={{ fontSize: "0.8rem", marginTop: 10 }}>Loading denominations…</p>
          )}

          {productInfo && !productLoading && (
            <>
              {productInfo.isRange ? (
                <div className="line" style={{ marginTop: 10 }}>
                  <span className="muted">
                    Amount ({cur})
                    <span style={{ fontSize: "0.72rem", marginLeft: 6 }}>
                      {productInfo.min}–{productInfo.max}
                    </span>
                  </span>
                  <input
                    style={{ maxWidth: 110, textAlign: "right" }}
                    type="number"
                    min={productInfo.min}
                    max={productInfo.max}
                    step={productInfo.step ?? 1}
                    value={faceValue}
                    onChange={(e) => { setFaceValue(Number(e.target.value)); setQuote(null); }}
                  />
                </div>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 6px" }}>
                    Select amount ({cur})
                  </p>
                  <div className="denom-row">
                    {productInfo.denominations?.map((d) => (
                      <button
                        key={d}
                        className={`denom-btn${faceValue === d ? " selected" : ""}`}
                        onClick={() => { setFaceValue(d); setQuote(null); }}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Fallback when no product info loaded */}
          {!productInfo && !productLoading && (
            <div className="line" style={{ marginTop: 10 }}>
              <span className="muted">Face value</span>
              <input
                style={{ maxWidth: 100, textAlign: "right" }}
                type="number"
                value={faceValue}
                onChange={(e) => { setFaceValue(Number(e.target.value)); setQuote(null); }}
              />
            </div>
          )}

          <button className="primary" onClick={getQuote} disabled={loading || productLoading}>
            {loading ? "…" : "Get CRC quote"}
          </button>

          {quote && (
            <>
              <div className="line" style={{ marginTop: 12 }}>
                <span className="muted">
                  Card value
                  {cur && <span style={{ fontSize: "0.75rem", marginLeft: 4 }}>({cur})</span>}
                </span>
                <span>
                  {faceValue} {cur || ""}
                  <span className="muted" style={{ fontSize: "0.8rem", marginLeft: 6 }}>
                    = {quote.priceUsdc.toFixed(2)} USDC
                  </span>
                </span>
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
                    ? `${crcDisplay(quote.crcTotalWei)} CRC`
                    : `≈ ${quote.usdcTotal.toFixed(2)} USDC in CRC`}
                </span>
              </div>
              <p className="muted" style={{ fontSize: "0.75rem" }}>
                Quote expires at <Countdown expiresAt={quote.expiresAt} /> — re-priced on expiry.
              </p>
              {walletAddress ? (
                <button className="primary" onClick={pay} disabled={loading}>
                  {loading ? "Creating order…" : "Pay with Circles"}
                </button>
              ) : (
                <button className="primary" onClick={connectWallet} disabled={walletConnecting}>
                  {walletConnecting ? "Connecting…" : "Connect wallet to pay"}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {order && (
        <div className="quote-box">
          {order.status === "AWAITING_DEPOSIT" && (
            <>
              <p style={{ margin: "0 0 12px", fontWeight: 600 }}>Send CRC to complete your order</p>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div className="copy-row">
                    <span className="muted" style={{ fontSize: "0.8rem" }}>Amount</span>
                    <div className="copy-val">
                      <span>{crcDisplay(order.crcRequiredWei)} CRC</span>
                      <CopyButton text={crcDisplay(order.crcRequiredWei)} />
                    </div>
                  </div>
                  <div className="copy-row">
                    <span className="muted" style={{ fontSize: "0.8rem" }}>To address</span>
                    <div className="copy-val">
                      <span className="mono">{order.depositAddress.slice(0, 10)}…{order.depositAddress.slice(-6)}</span>
                      <CopyButton text={order.depositAddress} />
                    </div>
                  </div>
                  <div className="line" style={{ marginTop: 10 }}>
                    <span className="muted" style={{ fontSize: "0.8rem" }}>Expires in</span>
                    <Countdown expiresAt={order.expiresAt} />
                  </div>
                </div>
                <div style={{ flexShrink: 0, padding: 6, background: "#fff", borderRadius: 8 }}>
                  <QRCodeSVG value={order.depositAddress} size={96} />
                </div>
              </div>
              <p className="muted" style={{ fontSize: "0.75rem", marginTop: 10 }}>
                Open your Circles wallet, scan the QR code or paste the address, and send the exact CRC amount above.
              </p>
              <p className="muted" style={{ fontSize: "0.72rem" }}>
                Polling for deposit… (order {order.orderId.slice(0, 8)})
              </p>
            </>
          )}

          {["FUNDED", "SWAPPING", "SWAPPED", "PAYING", "PAID"].includes(order.status) && (
            <>
              <StatusSteps status={order.status} />
              <p style={{ marginTop: 14, marginBottom: 0, fontSize: "0.9rem" }}>
                {order.status === "FUNDED"   && "Deposit confirmed — starting CRC→USDC swap…"}
                {order.status === "SWAPPING" && "Swapping CRC → USDC via CoW Protocol…"}
                {order.status === "SWAPPED"  && "Swap complete — paying Cryptorefills…"}
                {order.status === "PAYING"   && "Paying Cryptorefills for your gift card…"}
                {order.status === "PAID"     && "Payment sent — fetching gift card code…"}
              </p>
            </>
          )}

          {order.status === "DELIVERED" && order.giftCard && (
            <>
              <p style={{ margin: "0 0 12px", fontWeight: 600, color: "var(--accent-2)" }}>
                ✓ Your gift card is ready!
              </p>
              <div className="gift-card">
                <span className="muted" style={{ fontSize: "0.75rem", display: "block", marginBottom: 4 }}>
                  {selected ? brandName(selected) : "Gift card"}
                </span>
                <div className="copy-val">
                  <span className="mono code">{order.giftCard.code}</span>
                  <CopyButton text={order.giftCard.code} />
                </div>
              </div>
              <button className="primary" style={{ marginTop: 14 }} onClick={reset}>Buy another</button>
            </>
          )}

          {["REFUNDING", "REFUNDED"].includes(order.status) && (
            <>
              <p style={{ margin: "0 0 8px", color: "#ffa94d" }}>
                {order.status === "REFUNDING" ? "⟳ Sending refund to your wallet…" : "✓ Refund sent"}
              </p>
              {order.txHashes.refund && (
                <p className="muted" style={{ fontSize: "0.75rem" }}>
                  Refund tx: <span className="mono">{order.txHashes.refund}</span>
                </p>
              )}
              <button className="primary" style={{ marginTop: 14 }} onClick={reset}>Start over</button>
            </>
          )}

          {order.status === "EXPIRED" && (
            <>
              <p style={{ margin: "0 0 8px", color: "var(--muted)" }}>
                Quote expired before deposit arrived. No funds were taken.
              </p>
              <button className="primary" onClick={reset}>Try again</button>
            </>
          )}

          {order.status === "FAILED" && (
            <>
              <p style={{ margin: "0 0 8px", color: "#ff7b72" }}>
                Something went wrong. Our team has been notified.
              </p>
              <p className="muted" style={{ fontSize: "0.75rem" }}>
                Support reference: <span className="mono">{order.orderId}</span>
              </p>
              <button className="primary" onClick={reset}>Start over</button>
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
