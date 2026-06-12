# Architecture

## Components

### 1. Mini app frontend (`apps/web`)
React + Vite single-page app, built to the Circles mini app spec
(https://docs.aboutcircles.com/miniapps). Two integration modes:

- **Embedded** (target): runs inside the Circles host environment; the user signs
  the CRC transfer directly with their Gnosis App passkey via the Circles SDK.
  Requires SDK integration + store listing (this repo's prepkit is the submission).
- **Standalone** (fallback / day-1): standard web app; CRC transfer approved via QR
  code / transaction URL opened in the Gnosis App.

The frontend is intentionally thin: catalog browsing, quote display, payment
hand-off, order status. All money logic lives server-side.

### 2. Orchestrator (`apps/server`)
Stateless-ish Node/TypeScript service plus a Postgres order ledger. Responsibilities:

- **Catalog proxy** — proxies the public Cryptorefills MCP read-only tools with
  caching (60 s) and rate limiting (1 req/s upstream, per their guidelines), and an
  identifying `User-Agent`.
- **Quoting** — `POST /api/quote`:
  1. `getProductPrice(brand, country, face_value, coin=USDC)` → USD/USDC price `P`.
  2. CoW Protocol quote on Gnosis: how much wrapped-CRC for `P + slippageBuffer`.
  3. Settlement routing (see SWAP-ROUTING.md) → expected bridge+gas cost `B`.
  4. Quote: `CRC_total = swapInput(P + B) × (1 + serviceFee)`, expiry 90 s,
     persisted with a quote id.
- **Deposit watcher** — subscribes to Gnosis Chain (wss RPC) for incoming CRC
  transfers to the per-order deposit address (orchestrator Safe with order-id
  reference, or counterfactual deposit addresses — see SECURITY.md). Confirms at
  1 block (Gnosis ~5 s blocks).
- **Swap executor** — unwraps personal/group CRC to ERC-20 as needed, submits a CoW
  Protocol order CRC→USDC with the quoted limit price. MEV-protected, partial-fill
  disabled.
- **Settlement/bridge** — if the chosen payment chain ≠ Gnosis, bridges USDC via
  Relay.link (same pattern as gnosis-card-x402: ~$0.03–0.10 flat, ~90 s).
- **Payment** — `validateOrder` → `createOrder` (PENDING) → x402 pay with USDC on
  the settlement chain → poll `getOrderStatus` until `DELIVERED`.
- **Delivery** — gift card code returned to the frontend over an authenticated
  session channel; never logged; encrypted at rest with per-order keys.

### 3. Shared packages
- `packages/cryptorefills-client` — typed JSON-RPC 2.0 client for
  `https://api.cryptorefills.com/mcp/http` (stateless HTTP MCP). Mirrors the
  reference client in Cryptorefills/agentic-commerce: rate limiting, timeouts,
  Retry-After handling, `structuredContent.result` unwrapping.
- `packages/swap-router` — CoW Protocol (Gnosis) quoting/execution + Relay.link
  bridge quoting + the cheapest-chain selection algorithm.

## Order state machine

```
QUOTED ─(CRC received)→ FUNDED ─(swap filled)→ SWAPPED ─(bridged if needed)→ SETTLED
   │                       │                       │                            │
   │ expiry                │ swap fail/timeout     │ bridge fail                │ x402 paid
   ▼                       ▼                       ▼                            ▼
EXPIRED                REFUNDING ◄─────────────────┘                     PAID ─→ DELIVERED
                           │                                              │
                           ▼                                              │ upstream fail
                       REFUNDED                                           ▼
                                                                   REFUNDING (USDC→CRC→user)
```

Every transition is persisted with tx hashes / upstream order ids for full audit.

## Failure modes & mitigations

| Failure | Mitigation |
|---|---|
| Quote expired before CRC arrives | CRC auto-refunded minus gas, or user accepts re-quote |
| CRC price moves > slippage buffer | CoW limit order simply doesn't fill → refund path |
| Underpayment / overpayment | Under: refund. Over: surplus refunded as CRC |
| Bridge stuck | Relay.link status polling + manual ops runbook; funds recoverable |
| Cryptorefills order fails after payment | Their refund semantics (partial refunds supported per their gift-card playbook); we refund user in CRC |
| Upstream MCP down | Catalog served from cache; checkout disabled with banner |

## Trust & demurrage notes (Circles-specific)

- Circles CRC demurrages (~7%/yr continuous). Quotes are short-lived (90 s) so
  demurrage within an order is negligible (<0.001%), but the deposit watcher uses
  demurraged-balance accounting from the Circles SDK, not raw transfer amounts.
- Users may pay in **personal CRC, group CRC, or wrapped ERC-20 CRC**. Liquidity
  lives in group/wrapped tokens; personal CRC is path-converted via the Circles
  pathfinder to a liquid group token before swapping. V1 supports the major group
  tokens with live Balancer/CoW liquidity; personal-CRC pathfinding is a fast-follow.

## Privacy

- No accounts required; orders are keyed by wallet address + order id.
- Gift card codes encrypted at rest, deleted after configurable retention (default 30 d).
- KYC/jurisdiction: we pass through Cryptorefills' country/jurisdiction rules
  (their catalog is already geo-classified); we add no extra data collection.
