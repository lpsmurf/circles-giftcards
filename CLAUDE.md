# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies (npm workspaces — run from root)
npm install

# Development (run both in separate terminals)
npm run dev:server    # orchestrator API on :3001
npm run dev:web       # React frontend on :5173 (proxied to :3001 via vite)

# Type checking (all workspaces)
npm run typecheck

# Build (all workspaces)
npm run build

# Single workspace
npm run typecheck -w apps/server
npm run typecheck -w apps/web
npm run build -w packages/swap-router
```

No test runner is configured yet. Type checking is the primary correctness gate.

## Environment

Copy and fill `apps/server/.env.example` → `apps/server/.env`.

- **Demo mode** (no keys needed): catalog browsing and quoting work immediately against live public APIs.
- **Execution mode** (M2, not yet implemented): requires `OPERATOR_KEY`, `ORCHESTRATOR_SAFE_ADDRESS`, `DATABASE_URL`, `GNOSIS_RPC_WSS`, and `CRC_TOKEN_ADDRESS`.

The server logs `execution pipeline DISABLED — demo mode` at startup when `OPERATOR_KEY` is absent.

## Architecture

This is an **npm workspaces monorepo** with two apps and two shared packages:

```
apps/web/          React + Vite mini app (standalone + embedded Circles SDK modes)
apps/server/       Express/TS orchestrator API (:3001)
packages/cryptorefills-client/   Typed JSON-RPC 2.0 client for api.cryptorefills.com/mcp/http
packages/swap-router/            CoW Protocol quoting/execution + Relay.link bridge routing
```

### Data flow

User selects product → `POST /api/quote` → orchestrator fetches USDC price from Cryptorefills MCP, quotes CRC amount from CoW Protocol on Gnosis → user pays CRC → deposit watcher fires → CoW swap CRC→USDC → optional Relay.link bridge to cheapest chain → x402 payment to Cryptorefills → gift card code returned.

### Server routes (`apps/server/src/`)

- `routes/catalog.ts` — proxies Cryptorefills MCP read-only tools with 60s cache and 1 req/s rate limit
- `routes/quote.ts` — `POST /api/quote` (brand, country, faceValue) → `Quote` with 90s expiry; in-memory store (M2: Postgres)
- `routes/order.ts` — `POST /api/order` (quoteId, payerAddress) → `OrderState`; delegates to `services/orderPipeline.ts`
- `services/orderPipeline.ts` — order state machine (AWAITING_DEPOSIT → FUNDED → SWAPPED → SETTLED → PAID → DELIVERED, with EXPIRED/REFUNDING/REFUNDED exits); execution pipeline is a skeleton gated on `OPERATOR_KEY` (M2)
- `services/depositWatcher.ts` — Gnosis Chain WSS watcher for incoming CRC transfers (M2)

### Shared packages

- `cryptorefills-client` exports typed wrappers for all MCP tools: `listBrands`, `searchProducts`, `getProductPrice`, `createOrder`, `getOrderStatus`, etc. The `purchaseElicitation` tool is blocked by policy.
- `swap-router` exports `quoteSellForExactBuy` (CoW buy-order quote), `executeSwap` (M2 skeleton), `relayBridge` functions, and `chainSelector` (cheapest-chain algorithm: Gnosis if accepted, else Base via Relay.link).

### Quote math

```
CRC_total = cowQuote(USDC_out = P + B) × (1 + slippage) × (1 + serviceFee)
```
Where P = product USDC price, B = settlement cost (bridge + gas). Defaults: slippage 1%, service fee 2%, quote TTL 90s.

### Frontend (`apps/web/src/App.tsx`)

Single-file React app in **standalone mode** (no Circles SDK yet). Vite proxies `/api/*` to `:3001`. Embedded mode (in-app passkey signing via Circles SDK) is planned for the store listing approval milestone.

### Key design constraints

- The execution pipeline (swap + bridge + x402 pay) is entirely M2 — current code throws `"not implemented"` when `OPERATOR_KEY` is set.
- No float: funds only transit the orchestrator Safe per order; every state transition persists tx hashes.
- Quotes re-price on expiry; amounts are never silently changed between quote and payment.
- CRC demurrage (~7%/yr) is accounted for via demurraged-balance reads from the Circles SDK, not raw transfer amounts.
