# Security & custody model

## Principle: minimize custody window

Funds transit the system for seconds-to-minutes per order. There is no pooled user
balance, no deposits product, no float. The attack surface is the **operator hot
wallet path** during a single order.

## Key & wallet architecture

| Wallet | Chain | Purpose | Custody |
|---|---|---|---|
| Orchestrator **Safe** (2/3 multisig) | Gnosis | Receives CRC, holds nothing at rest | Multisig; hot module below |
| Hot **execution module** (Safe module, scoped) | Gnosis | Auto: wrap, CoW order placement, bridge initiation | Server key, spend-limited per order + daily cap |
| Settlement hot wallets | Base / others | Pay x402 invoices | Server keys, balance kept ≈ 0 (just-in-time bridged) |
| Treasury Safe | Gnosis | Accumulated service fees, refund reserve | Multisig only, no server keys |

- The server never holds a key that can drain the Safe arbitrarily: the execution
  module enforces per-order amount limits tied to the persisted quote, plus a daily
  aggregate cap.
- A small **refund reserve** (target: 1 day of volume) lives in the treasury Safe so
  refunds never depend on reversing a swap.

## Refund semantics

- Pre-swap failure → return the exact CRC received (minus nothing; Gnosis gas is paid
  by the orchestrator).
- Post-swap failure → swap USDC back to CRC at market and return, or (user choice)
  refund in USDC on Gnosis.
- Upstream (Cryptorefills) failure after payment → follow their refund flow
  (full/partial refunds per their gift-card playbook), then refund the user.
- All refunds are automatic with a manual-ops escape hatch; every order keeps a full
  tx-hash audit trail.

## Upstream API hygiene

- Identifying `User-Agent` with contact URL on every Cryptorefills request.
- Documented endpoints only (`api.cryptorefills.com/mcp/http`); rate limited;
  `Retry-After` honored.
- `purchaseElicitation` (autonomous purchase loop tool) is never used — every order
  is explicitly user-initiated and pinned to a user-approved quote.

## Application security

- Gift card codes: encrypted at rest (per-order data key, KMS-wrapped), shown once
  over an authenticated session, purged after retention window.
- No PII collected beyond what Cryptorefills requires per product/jurisdiction.
- Quote tampering: quotes are server-signed; the deposit watcher only matches
  payments against server-persisted quotes.
- Standard: dependency audit in CI, no secrets in repo, `.env` based config,
  least-privilege RPC keys.

## Open items before mainnet

- [ ] External review of the Safe module spend-limit logic
- [ ] Incident runbook (stuck bridge, upstream outage, key compromise rotation)
- [ ] Monitoring: per-order SLO alerts, wallet balance alarms, upstream status probe
