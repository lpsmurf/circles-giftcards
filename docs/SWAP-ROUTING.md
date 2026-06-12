# Swap & settlement routing

## Goal
Convert the user's CRC into USDC/USDT **on whichever Cryptorefills-supported chain
is cheapest all-in**, with no inventory float.

## Step 1 — CRC → USDC on Gnosis (always)

All CRC liquidity lives on Gnosis Chain, so the first leg is fixed:

1. If the user pays personal/group CRC (ERC-1155-style Circles v2), wrap to the
   ERC-20 wrapper via the Circles SDK (`wrap` on the demurraged wrapper).
2. Swap wrapped CRC → USDC on Gnosis via **CoW Protocol** (batch-auction,
   MEV-protected, gasless for the seller). Fallback: direct Balancer v2 pool swap
   if CoW has no solver coverage for the pair at that size.
3. Limit price = quoted price; `partiallyFillable = false`; validity = quote expiry.

## Step 2 — Pick the settlement chain

Cryptorefills accepts USDC/USDT on (per `getPaymentViasWithCurrencies`, fetched
live, cached 10 min): Ethereum, Base, Polygon, Tron, Solana, … and possibly Gnosis.

For each candidate chain `c`:

```
cost(c) = bridgeFee(Gnosis→c)        // 0 if c == Gnosis or no bridge needed
        + gasCost(c, paymentTx)      // est. in USD
        + upstreamFee(c)             // any per-via fee Cryptorefills reports
```

Choose `argmin cost(c)`. In practice: **Gnosis if accepted (gas ≈ $0.001), else
Base via Relay.link (~$0.03–0.10 bridge, ~90 s, cents of gas)**. Ethereum mainnet
is effectively never chosen.

Bridging uses **Relay.link** (proven in our gnosis-card-x402 package). The router
re-quotes the bridge at execution time; if the live cost exceeds the buffered
quote, the order pauses for re-quote rather than eating the difference.

## Step 3 — Pay

x402 flow: `createOrder` returns payment requirements (amount, token, chain,
address, deadline); the operator wallet on the settlement chain pays exactly that;
`getOrderStatus` polled until `DELIVERED`.

## Slippage & fee accounting (per order)

```
P   = product price in USDC (Cryptorefills)
B   = settlement cost (bridge + gas), routed minimum
S   = slippage buffer (default 1%, surplus refunded)
F   = service fee (default 2%)

CRC_total = cowQuote(USDC_out = P + B) × (1 + S) × (1 + F)
```

Everything is shown line-itemized in the quote UI before the user signs.
