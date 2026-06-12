# Circles Gift Cards — Spend your CRC on real-world gift cards

A **Circles mini app** for the Gnosis ecosystem that lets users pay for gift cards,
mobile top-ups and digital services with **Circles (CRC)** or any Gnosis Chain token.

> User sends CRC → automatic swap to USDC/USDT on the cheapest chain → x402 payment
> to [Cryptorefills](https://www.cryptorefills.com) → user receives the gift card code.
> No float, no custody beyond a single in-flight transaction.

## Why

Circles gives people unconditional, community-issued money — but there are few places
to *spend* it. Cryptorefills offers 5,000+ gift card and top-up products in 180+
countries, payable in stablecoins via their public MCP/x402 API. This mini app is the
bridge: it turns CRC into everyday purchasing power without users ever touching an
exchange.

## How it works (60 seconds)

```
 ┌──────────┐  1. browse catalog        ┌─────────────────────┐
 │  User    │ ───────────────────────►  │  Mini app (web)      │
 │ (Circles │  2. quote in CRC          │  Circles SDK / QR    │
 │  wallet) │ ◄───────────────────────  └────────┬────────────┘
 └────┬─────┘                                    │
      │ 3. send CRC (one tx, signed in           │
      │    Circles app via passkey/QR)           ▼
      │                              ┌───────────────────────┐
      └────────────────────────────► │  Orchestrator (Safe)  │
                                     │  on Gnosis Chain      │
                                     └────┬──────────────────┘
                4. unwrap + swap CRC→USDC │  (CoW Protocol / Balancer on Gnosis)
                5. bridge iff cheaper     │  (Relay.link, only when needed)
                6. createOrder + x402 pay ▼
                                     ┌───────────────────────┐
                                     │  Cryptorefills MCP    │
                                     │  api.cryptorefills.com│
                                     └────┬──────────────────┘
                7. gift card code         │
      ◄───────────────────────────────────┘
```

1. **Browse** — the mini app proxies the public Cryptorefills MCP catalog
   (`listBrands`, `searchProducts`, `getProductPrice`). No API key needed for catalog.
2. **Quote** — we price the product in USDC, fetch the live CRC→USDC rate from CoW
   Protocol on Gnosis, add a transparent service fee, and show a CRC total with a
   short expiry (quotes re-price on expiry, never silently).
3. **Pay in CRC** — embedded mode: one passkey signature inside the Circles app.
   Standalone mode: QR / transaction URL.
4. **Auto-swap** — the orchestrator receives CRC, unwraps/wraps as needed (ERC-20
   wrapped CRC), and swaps to USDC on Gnosis via CoW Protocol (MEV-protected).
5. **Cheapest-chain settlement** — Cryptorefills accepts USDC/USDT on several chains.
   We settle on Gnosis when accepted; otherwise we route via Relay.link to whichever
   supported chain is cheapest *all-in* (bridge fee + gas + payment fee).
6. **x402 payment** — order is created (`createOrder`, PENDING) and paid via the
   x402 stablecoin flow. We poll `getOrderStatus` until delivery.
7. **Delivery** — the gift card code / top-up confirmation is shown in-app and
   (optionally) emailed.

## Business model

- Small transparent service fee (target **1.5–2.5%**) added on top of the
  Cryptorefills price, disclosed in the quote before the user signs anything.
- Swaps and payment are atomic-ish and fast (seconds to ~2 min), so **we never float
  inventory** — funds only transit through the orchestrator Safe per order.
- Slippage buffer is part of the quote; surplus is refunded as CRC or credited.

## Repository layout

| Path | What |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Full technical architecture, sequence diagrams, failure modes |
| [`docs/SWAP-ROUTING.md`](docs/SWAP-ROUTING.md) | CRC→stable routing & cheapest-chain selection |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Custody model, key management, refund semantics |
| [`prepkit/`](prepkit/) | Ecosystem submission kit: one-pager, FAQ, milestones, grant ask |
| [`apps/web/`](apps/web/) | Mini app frontend (React + Vite, Circles SDK) |
| [`apps/server/`](apps/server/) | Orchestrator API (Node/TS): quotes, deposit watcher, swap, pay, deliver |
| [`packages/cryptorefills-client/`](packages/cryptorefills-client/) | Typed client for the public Cryptorefills MCP (JSON-RPC over HTTP) |
| [`packages/swap-router/`](packages/swap-router/) | CoW Protocol swap + Relay.link bridge routing |

## Quick start (dev)

```bash
npm install
cp apps/server/.env.example apps/server/.env   # fill in keys (see file)
npm run dev:server    # orchestrator on :3001 — catalog endpoints work with no keys
npm run dev:web       # mini app on :5173
```

Catalog browsing works immediately against the live public Cryptorefills MCP
(no API key, rate-limited to 1 req/s by default). Swapping and paying require a
funded operator wallet — see [`docs/SECURITY.md`](docs/SECURITY.md).

## Status

🟡 **Proposal stage.** Catalog + quoting are functional against live APIs; the
swap/pay pipeline is implemented as reviewed skeletons pending ecosystem approval
and a Cryptorefills partner account. See [`prepkit/MILESTONES.md`](prepkit/MILESTONES.md).

## Links

- Circles mini apps: https://docs.aboutcircles.com/miniapps
- Cryptorefills agentic commerce: https://github.com/Cryptorefills/agentic-commerce
- Cryptorefills MCP manifest: https://www.cryptorefills.com/.well-known/mcp.json

## Contact

**HFSP Labs** — info@hfsp.xyz · [hfsp.xyz](https://hfsp.xyz)

## License

MIT
