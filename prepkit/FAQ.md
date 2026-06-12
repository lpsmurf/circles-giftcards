# FAQ — anticipated reviewer questions

**Do you custody user funds?**
Only in transit, per order, for seconds-to-minutes. CRC arrives at a 2/3 multisig
Safe whose hot execution module is spend-limited to the order's signed quote plus a
daily cap. There is no deposits product and no pooled balance. See `docs/SECURITY.md`.

**What about CRC demurrage?**
Quotes live 90 seconds; demurrage within that window is <0.001%. Balance accounting
uses the Circles SDK's demurraged values, never raw transfer amounts.

**Which CRC can users pay with?**
V1: liquid wrapped/group CRC tokens with live Balancer/CoW pools on Gnosis.
Personal-CRC via pathfinder conversion to a group token is a fast-follow (M3).

**What if the swap or bridge fails after the user paid?**
Automatic refund path at every stage: pre-swap → exact CRC back; post-swap →
USDC swapped back to CRC (or USDC on Gnosis, user's choice); post-payment upstream
failure → Cryptorefills refund flow, then user refund. Refund reserve held in a
multisig treasury so refunds never depend on reversing a swap.

**Is this regulated activity / do you KYC?**
Cryptorefills is the merchant of record and applies its own jurisdiction rules per
product (their catalog is geo-classified). We collect no extra PII. Because the
orchestrator briefly converts crypto→crypto for users, we are obtaining a legal
opinion on MiCA/VASP classification before mainnet launch — flagged transparently
in `docs/SECURITY.md`.

**Why won't you just drain liquidity from CRC pools?**
Typical orders are €10–50 gift cards. We enforce a per-order size cap derived from
live pool depth so a single order cannot move the CRC price beyond the quoted
slippage buffer.

**Why Cryptorefills and not another provider?**
Public, documented, crypto-native API (MCP + x402), 5,000+ products, 180+
countries, stablecoin settlement on multiple chains, and an explicit agentic
commerce reference stack we build against. No card-network intermediary needed.

**Do you use autonomous AI purchasing?**
No. The upstream `purchaseElicitation` tool (autonomous purchase loops) is
explicitly excluded. Every order is initiated by a user and pinned to a quote they
approved with their own signature.

**What does the fee pay for?**
Gas on all legs, bridge fees, slippage-buffer shortfalls, refund reserve, and
operations. Target 1.5–2.5%, always line-itemized before signature.

**What happens if Cryptorefills' API is down?**
Catalog is served from cache with checkout disabled and a clear banner. In-flight
orders pause before the swap step (full CRC refund available); paid orders follow
the upstream refund flow.
