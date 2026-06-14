# Ops Runbook — Circles Gift Cards

## Quick reference

| What | Command |
|------|---------|
| Check health | `curl https://card.hfsp.cloud/health` |
| Full status (key-gated) | `curl -H "Authorization: Bearer $ADMIN_KEY" https://card.hfsp.cloud/api/admin/status` |
| View all logs | `docker compose logs -f server` |
| Restart server | `docker compose restart server` |
| Deploy update | `./scripts/deploy.sh` |
| DB shell | `docker compose exec db psql -U circles circles_giftcards` |

---

## Initial server setup

```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker $USER && newgrp docker

# 2. Clone repo
git clone https://github.com/YOUR_ORG/circles-giftcards.git /opt/circles-giftcards
cd /opt/circles-giftcards

# 3. Generate secrets
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env.prod
echo "ADMIN_KEY=$(openssl rand -hex 32)"          >> .env.prod
echo "GIFT_CARD_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env.prod

# 4. Fill in apps/server/.env (copy from .env.example, add real keys)
cp apps/server/.env.example apps/server/.env
# → set OPERATOR_KEY, ORCHESTRATOR_SAFE_ADDRESS, CRC_TOKEN_ADDRESS,
#   GNOSIS_RPC_WSS, GNOSIS_RPC_HTTP, AGENTMAIL_API_KEY

# 5. TLS certificate (Let's Encrypt)
mkdir -p nginx/certs
apt install certbot

# NOTE: `certbot --standalone` binds to port 80 and will fail if nginx is running.
# If you prefer the standalone flow, stop nginx first (e.g. `systemctl stop nginx`) before
# running the command below. Alternatively, use the `--webroot` plugin to obtain certs
# while nginx remains running (recommended for zero-downtime setups).

# Standalone (stop nginx first):
certbot certonly --standalone -d card.hfsp.cloud
cp /etc/letsencrypt/live/card.hfsp.cloud/fullchain.pem nginx/certs/
cp /etc/letsencrypt/live/card.hfsp.cloud/privkey.pem   nginx/certs/

# Webroot alternative (run alongside nginx):
# 1) Ensure nginx serves the ACME challenge at /.well-known/acme-challenge/
#    Add this location block to nginx/nginx.conf inside the server {} block:
#
#    location /.well-known/acme-challenge/ {
#      root /var/www/certbot;
#      try_files $uri =404;
#    }
#
# 2) Create the webroot directory and run certbot with --webroot:
#    mkdir -p /var/www/certbot
#    certbot certonly --webroot -w /var/www/certbot -d card.hfsp.cloud
#    cp /etc/letsencrypt/live/card.hfsp.cloud/fullchain.pem nginx/certs/
#    cp /etc/letsencrypt/live/card.hfsp.cloud/privkey.pem   nginx/certs/

# Update nginx/nginx.conf: replace card.hfsp.cloud with the real domain.

# 6. First deploy
source .env.prod && ./scripts/deploy.sh
```

Auto-renew TLS:
```bash
# /etc/cron.d/certbot-renew
0 3 * * * root certbot renew --quiet && \
  cp /etc/letsencrypt/live/card.hfsp.cloud/fullchain.pem /opt/circles-giftcards/nginx/certs/ && \
  cp /etc/letsencrypt/live/card.hfsp.cloud/privkey.pem   /opt/circles-giftcards/nginx/certs/ && \
  docker compose -f /opt/circles-giftcards/docker-compose.yml restart web
```

---

## Monitoring

### Public health check
```bash
curl https://card.hfsp.cloud/health
# → {"ok":true,"checks":[{"name":"db","ok":true},{"name":"upstream","ok":true}]}
```
- Returns **200** when healthy, **503** when any check fails.
- Good for uptime monitors (UptimeRobot, BetterStack, etc.).

### Admin status
```bash
curl -H "Authorization: Bearer $ADMIN_KEY" https://card.hfsp.cloud/api/admin/status | jq
```
Returns:
- `checks` — DB + upstream Cryptorefills reachability
- `balances.crc` / `balances.usdc` — wallet balances with warn thresholds
- `pipeline.pendingCount` — orders currently awaiting deposit
- `pipeline.oldestPendingAgeMs` — age of oldest open order
- `watcher.running` / `watcher.lastEventAt` — deposit watcher liveness

### What to alert on
| Condition | Action |
|-----------|--------|
| `/health` returns 503 | Page on-call; check `docker compose logs server` |
| `watcher.running = false` | Restart server; WSS connection dropped |
| `watcher.lastEventAt` > 30 min ago | Check Gnosis RPC; may be a silent disconnect |
| `balances.crc.ok = false` | Top up orchestrator Safe with s-gCRC |
| `balances.usdc.ok = false` | Top up orchestrator Safe with USDC.e |
| `pipeline.oldestPendingAgeMs` > 90 min | Check for expired orders not being cleaned up |

---

## Order lifecycle

```
AWAITING_DEPOSIT → FUNDED → SWAPPING → SWAPPED → PAYING → PAID → DELIVERED
                                                                 ↘ (code via email inbox)
                ↘ EXPIRED
         ↘ REFUNDING → REFUNDED
                     ↘ FAILED (manual ops required)
```

### Query an order
```sql
SELECT order_id, status, brand, face_value, payer_address,
       crc_received_wei, usdc_swapped_wei, upstream_order_id,
       expires_at, updated_at, tx_hashes
FROM orders
WHERE order_id = 'UUID';
```

### All orders by status
```sql
SELECT status, count(*) FROM orders GROUP BY status ORDER BY count DESC;
```

### Orders stuck > 2 hours
```sql
SELECT order_id, status, updated_at, brand, face_value
FROM orders
WHERE status NOT IN ('DELIVERED','REFUNDED','FAILED','EXPIRED')
  AND updated_at < NOW() - INTERVAL '2 hours'
ORDER BY updated_at;
```

---

## Incident playbook

### Unmatched deposit
Logged as: `UNMATCHED DEPOSIT — from=0x… value=… tx=0x…`

Someone sent CRC to the Safe but no matching order exists (order expired, typo, etc.).
```bash
# 1. Find the tx on Gnosis chain
#    https://gnosisscan.io/tx/0xTXHASH

# 2. Identify the sender (from= address)
# 3. Manually refund via cast (Foundry) or Safe UI:
cast send $CRC_TOKEN_ADDRESS \
  "transfer(address,uint256)" \
  $SENDER_ADDRESS $AMOUNT_WEI \
  --private-key $OPERATOR_KEY \
  --rpc-url $GNOSIS_RPC_HTTP
```

### FAILED order (swap or payment failed, refund also failed)
```sql
-- Check what stage it failed at
SELECT order_id, tx_hashes->>'refundStage' as stage,
       tx_hashes->>'deposit' as deposit_tx,
       tx_hashes->>'cowOrderUid' as cow_uid,
       crc_received_wei, usdc_swapped_wei, payer_address
FROM orders WHERE order_id = 'UUID';
```

**Pre-swap failure** (CRC arrived, swap never completed):
```bash
# Refund CRC to the payer
cast send $CRC_TOKEN_ADDRESS \
  "transfer(address,uint256)" \
  $PAYER_ADDRESS $CRC_RECEIVED_WEI \
  --private-key $OPERATOR_KEY \
  --rpc-url $GNOSIS_RPC_HTTP

# Update DB after successful refund
UPDATE orders SET status='REFUNDED', tx_hashes = tx_hashes || '{"refund":"0xTXHASH"}'
WHERE order_id = 'UUID';
```

**Post-swap failure** (USDC in Safe, payment to Cryptorefills failed):
```bash
# Refund USDC.e to the payer
USDC=0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0
cast send $USDC \
  "transfer(address,uint256)" \
  $PAYER_ADDRESS $USDC_SWAPPED_WEI \
  --private-key $OPERATOR_KEY \
  --rpc-url $GNOSIS_RPC_HTTP
```

### Cryptorefills order PAID but no gift card code
```bash
# Check upstream order status directly
UPSTREAM_ORDER_ID=$(psql $DATABASE_URL -t -c \
  "SELECT upstream_order_id FROM orders WHERE order_id='UUID'")

curl https://api.cryptorefills.com/mcp/http \
  -H "Content-Type: application/json" \
  -d "{\"method\":\"getOrderStatus\",\"params\":{\"order_id\":\"$UPSTREAM_ORDER_ID\"}}"
```
If status is DELIVERED but our DB doesn't have the code, check the AgentMail inbox manually or contact Cryptorefills support with the upstream order ID.

### CoW order stuck (SWAPPING for > 10 min)
```sql
SELECT tx_hashes->>'cowOrderUid' as uid FROM orders WHERE order_id='UUID';
```
```bash
# Check CoW explorer
open https://explorer.cow.fi/gc/orders/$COW_UID

# If cancelled/expired, the server will refund automatically on next check.
# If it just needs more time (low gas), wait — CoW batches run every ~30s on Gnosis.
```

### Deposit watcher dropped
```bash
docker compose logs server --tail=50 | grep -E "watcher|WSS|websocket"
docker compose restart server
# Server reconnects automatically on startup via watchDeposits()
```

---

## Key rotation

### Rotate OPERATOR_KEY
1. Generate new key: `cast wallet new`
2. Fund new address with xDAI for gas
3. Transfer CRC balance from old Safe to new address (or update Safe owner)
4. Update `OPERATOR_KEY` in `apps/server/.env`
5. Restart server: `docker compose restart server`
6. Verify new key is operational: check `/api/admin/status`

### Rotate GIFT_CARD_ENCRYPTION_KEY
The new key only affects rows written after the rotation. Old rows used the old key.
To re-encrypt historical rows you need a migration script — contact eng.

### Rotate ADMIN_KEY
Update in `apps/server/.env` and restart. No DB changes needed.

---

## Database

### Backup
```bash
docker compose exec db pg_dump -U circles circles_giftcards | gzip \
  > backup_$(date +%Y%m%d_%H%M%S).sql.gz
```

### Restore
```bash
gunzip -c backup_TIMESTAMP.sql.gz | \
  docker compose exec -T db psql -U circles circles_giftcards
```

### Manual DB access
```bash
docker compose exec db psql -U circles circles_giftcards
```

---

## Wallet top-up thresholds

| Asset | Warn below | Why |
|-------|-----------|-----|
| s-gCRC | 50 × 10¹⁸ wei (50 CRC) | Need CRC for quotes; below this users can't get quotes |
| USDC.e | 10 USDC (10 × 10⁶ wei) | Needed for gas on post-swap payment path |
| xDAI | Keep > 0.1 | Gas for Safe transactions on Gnosis |

Safe address: `ORCHESTRATOR_SAFE_ADDRESS` in `.env`
Top up via: [app.safe.global](https://app.safe.global) or direct transfer.
