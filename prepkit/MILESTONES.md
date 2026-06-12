# Milestones & roadmap

## M1 — Catalog + quoting (DONE in this repo, no keys required)
- Typed client for the public Cryptorefills MCP (rate-limited, identified UA)
- Catalog proxy API with caching; live brand/product/price data
- CRC quoting engine: CoW quote on Gnosis + line-itemized fee math, signed quotes
- Mini app frontend: browse, product page, quote screen (standalone mode)

## M2 — Gnosis-settled end-to-end (4–6 weeks)
- Deposit watcher on Gnosis (wss), order state machine + Postgres ledger
- CoW swap execution (wrapped CRC → USDC), Safe + spend-limited execution module
- x402 payment + `getOrderStatus` polling + code delivery (encrypted at rest)
- Automatic refund paths; ops runbook; testnet (Chiado) then capped mainnet beta
  (per-order limit ~€50, daily cap)
- **Gate:** external review of the Safe module; legal opinion on MiCA classification

## M3 — Multi-chain routing + embedded listing (4 weeks after M2)
- Cheapest-chain selector live (Relay.link bridging to Base/Polygon when cheaper)
- Circles SDK embedded mode + mini app store listing
- Personal-CRC support via pathfinder conversion to liquid group tokens
- Raise caps based on beta data; public dashboard (volume, fees, refund rate)

## Grant ask (indicative)
| Item | Est. |
|---|---|
| M2 engineering (2 devs × 6 wks) | €30k |
| Security review (Safe module + pipeline) | €10k |
| Legal opinion (MiCA/VASP) | €8k |
| 6 months ops (RPC, infra, monitoring, refund reserve seed) | €12k |
| **Total** | **€60k** |

## KPIs we'll report
Orders/week, CRC volume swapped, median end-to-end latency, refund rate,
effective all-in user cost vs. face value.
