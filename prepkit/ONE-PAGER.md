# Circles Gift Cards — One-pager

**Submission to:** Circles / Gnosis ecosystem (mini app listing + ecosystem support)
**Team:** HFSP Labs — info@hfsp.xyz · https://hfsp.xyz
**Status:** Catalog + quoting functional against live public APIs; payment pipeline scaffolded.

## The problem

Circles gives communities unconditional basic income in CRC — but there are almost
no places to **spend** CRC on real-world goods. Without spendability, CRC velocity
and perceived value stay low, which is the single biggest adoption blocker for the
Circles economy.

## The solution

A Circles mini app where users buy **gift cards, mobile top-ups and digital
services** (5,000+ products, 180+ countries via Cryptorefills) directly with CRC:

1. User picks a product, sees a transparent CRC quote (price + line-itemized fee).
2. One signature in the Circles/Gnosis app (passkey when embedded; QR when standalone).
3. Our orchestrator auto-swaps CRC→USDC on Gnosis (CoW Protocol, MEV-protected),
   settles on the cheapest Cryptorefills-supported chain (Relay.link when bridging
   is needed), and pays via the x402 stablecoin flow.
4. Gift card code delivered in-app, typically under 2 minutes end-to-end.

**No float, no pooled custody** — funds transit per-order through a spend-limited
Safe module. Full architecture in `docs/ARCHITECTURE.md`.

## Why this is good for Circles & Gnosis

- **Spendability**: the first generic "CRC → real-world goods" off-ramp; makes UBI
  in CRC tangible (groceries-adjacent gift cards, phone credit, transport, gaming).
- **All settlement starts on Gnosis Chain**: CRC swap liquidity, CoW Protocol
  volume, and Safe usage all accrue to the Gnosis ecosystem.
- **No new trust assumptions**: built on Circles SDK, CoW, Safe, Relay.link and a
  public merchant API. We never use autonomous-purchase tooling; every order is
  explicitly user-approved against a signed quote.

## Business model

Transparent service fee (target 1.5–2.5%) per transaction, disclosed pre-signature.
Because swaps are instant, we hold zero inventory — costs scale with volume only.
Near-term sustainability via ecosystem support (see grant ask); long-term via fee
volume as Circles adoption grows.

## Prior shipped work (team credibility)

HFSP Labs built **gnosis-card-x402**: USDC top-ups for Gnosis Pay Safes from
Solana/Base via x402 + Relay.link (~90 s settlement, 0.5% fee) — the same bridging
and payment pattern this mini app reuses.

## The ask

1. **Mini app store listing** (embedded mode) and Circles SDK integration support.
2. **Ecosystem grant** to cover M1–M3 (see `MILESTONES.md`): security review of the
   Safe spend-limit module, liquidity coordination for wrapped-CRC pools, and
   6 months of operations runway.
3. Intro to the Cryptorefills team for a partner/merchant account (we already build
   on their public agentic-commerce stack).
