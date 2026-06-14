#!/usr/bin/env bash
# Chiado testnet bootstrap
#
# Prerequisites:
#   - Foundry installed:  curl -L https://foundry.paradigm.xyz | bash && foundryup
#   - OPERATOR_KEY env var set (private key, with or without 0x prefix)
#   - Chiado xDAI in the operator wallet:
#       https://faucet.gnosis.io/  or  https://gnosisfaucet.com/
#   - ORCHESTRATOR_SAFE_ADDRESS set (deploy at https://app.safe.global, select Chiado)
#
# Usage:
#   OPERATOR_KEY=0x... ORCHESTRATOR_SAFE_ADDRESS=0x... bash scripts/chiado/bootstrap.sh

set -euo pipefail

RPC="https://rpc.chiado.gnosis.gateway.fm"
CHAIN_ID=10200
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${OPERATOR_KEY:?Set OPERATOR_KEY to your test private key}"
: "${ORCHESTRATOR_SAFE_ADDRESS:?Set ORCHESTRATOR_SAFE_ADDRESS to your Chiado Safe address}"

OPERATOR_ADDR=$(cast wallet address --private-key "$OPERATOR_KEY")
echo "Operator address : $OPERATOR_ADDR"
echo "Safe address     : $ORCHESTRATOR_SAFE_ADDRESS"

BALANCE=$(cast balance --rpc-url "$RPC" "$OPERATOR_ADDR")
echo "Operator balance : $BALANCE wei"

if [ "$BALANCE" = "0" ]; then
  echo ""
  echo "⚠  No Chiado xDAI. Get some first:"
  echo "   https://faucet.gnosis.io/"
  echo "   https://gnosisfaucet.com/"
  exit 1
fi

echo ""
echo "── Deploying MockERC20 (mock CRC token) ────────────────"
CRC_ADDR=$(forge create \
  --rpc-url "$RPC" \
  --chain-id "$CHAIN_ID" \
  --private-key "$OPERATOR_KEY" \
  "$SCRIPT_DIR/MockERC20.sol:MockERC20" \
  --constructor-args "Mock Circles CRC" "mCRC" \
  --json | jq -r .deployedTo)

echo "Mock CRC deployed : $CRC_ADDR"

echo ""
echo "── Minting 10,000 mCRC to Safe ─────────────────────────"
cast send \
  --rpc-url "$RPC" \
  --chain-id "$CHAIN_ID" \
  --private-key "$OPERATOR_KEY" \
  "$CRC_ADDR" \
  "mint(address,uint256)" \
  "$ORCHESTRATOR_SAFE_ADDRESS" \
  "10000000000000000000000"

echo "Minted 10,000 mCRC to $ORCHESTRATOR_SAFE_ADDRESS"

SAFE_BAL=$(cast call --rpc-url "$RPC" "$CRC_ADDR" "balanceOf(address)(uint256)" "$ORCHESTRATOR_SAFE_ADDRESS")
echo "Safe mCRC balance : $SAFE_BAL wei"

echo ""
echo "── Done ─────────────────────────────────────────────────"
echo "Add to your .env (copy from .env.chiado.example first):"
echo ""
echo "  CRC_TOKEN_ADDRESS=$CRC_ADDR"
echo "  ORCHESTRATOR_SAFE_ADDRESS=$ORCHESTRATOR_SAFE_ADDRESS"
echo ""
echo "Then start the server:"
echo "  cp apps/server/.env.chiado.example apps/server/.env"
echo "  # fill in OPERATOR_KEY + the addresses above"
echo "  npm run dev:server"
