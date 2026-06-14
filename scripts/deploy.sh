#!/usr/bin/env bash
# Deploy or update circles-giftcards on the production VPS.
# Run from the repo root on the server after pulling latest.
set -euo pipefail

COMPOSE="docker compose"

echo "==> Pulling latest images / rebuilding..."
$COMPOSE build --pull

echo "==> Applying DB migrations (via server startup)..."
# Migrations run automatically when the server starts with DATABASE_URL set.

echo "==> Rolling update (zero-downtime: db stays up, server/web restart)..."
$COMPOSE up -d --no-deps db
$COMPOSE up -d --no-deps --build server
$COMPOSE up -d --no-deps --build web

echo "==> Waiting for health check (retrying)..."
# Prefer `jq` if available, otherwise fall back to a shell-friendly grep check.
MAX_ATTEMPTS=12
SLEEP_SECONDS=5
attempt=1
STATUS="UNREACHABLE"
while [ $attempt -le $MAX_ATTEMPTS ]; do
	RESP=$(curl -sS http://localhost/health || true)
	if [ -n "${RESP}" ]; then
		if command -v jq >/dev/null 2>&1; then
			ok=$(echo "${RESP}" | jq -r '.ok' 2>/dev/null || echo "false")
			if [ "${ok}" = "true" ]; then
				STATUS="OK"
				break
			else
				STATUS="DEGRADED"
			fi
		else
			# Look for a simple ""ok":true" token in the JSON (robust enough here).
			if echo "${RESP}" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
				STATUS="OK"
				break
			else
				STATUS="DEGRADED"
			fi
		fi
	fi
	printf "    attempt %d/%d: /health not ready
" "$attempt" "$MAX_ATTEMPTS"
	attempt=$((attempt+1))
	sleep ${SLEEP_SECONDS}
done
echo "    /health → $STATUS"

echo "==> Done. Container status:"
$COMPOSE ps
