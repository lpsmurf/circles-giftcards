import { Router } from "express";
import {
  listBrands,
  listProductsForCountry,
  searchProducts,
  getPaymentViasWithCurrencies,
} from "@circles-giftcards/cryptorefills-client";

// Cached proxy of the public Cryptorefills catalog. The cache keeps us well
// under the upstream rate limit even with many concurrent users.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}

export const catalogRouter = Router();

catalogRouter.get("/brands", async (req, res) => {
  try {
    const country = String(req.query.country ?? "DE").toUpperCase();
    res.json(await cached(`brands:${country}`, () => listBrands(country)));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

catalogRouter.get("/products", async (req, res) => {
  try {
    const country = String(req.query.country ?? "DE").toUpperCase();
    const brand = req.query.brand ? String(req.query.brand) : undefined;
    // Pass explicit coin filter when provided; callers can request coin=USDC to
    // see only stablecoin-priced products.
    const coin = req.query.coin ? String(req.query.coin) : undefined;
    res.json(
      await cached(`products:${country}:${brand ?? ""}:${coin ?? ""}`, () =>
        listProductsForCountry({ country_code: country, brand_name: brand, coin }),
      ),
    );
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

catalogRouter.get("/search", async (req, res) => {
  try {
    const country = String(req.query.country ?? "DE").toUpperCase();
    const q = String(req.query.q ?? "");
    if (!q) return res.status(400).json({ error: "q required" });
    res.json(await cached(`search:${country}:${q}`, () => searchProducts(country, q)));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

catalogRouter.get("/payment-vias", async (_req, res) => {
  try {
    res.json(await cached("vias", () => getPaymentViasWithCurrencies()));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});
