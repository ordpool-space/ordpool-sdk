#!/usr/bin/env bash
# Bring up the consumer-environment compose stack — bitcoind, electrs,
# mariadb (always) + redis (when --with-redis is passed) — mine 101
# blocks to mature coinbase, then print a JSON descriptor on stdout
# with every URL the consumer's Playwright spec needs to talk to the
# stack.
#
# Usage:
#   ./e2e/consumer-environment-bootstrap.sh                  # base + mariadb
#   ./e2e/consumer-environment-bootstrap.sh --with-redis     # + redis
#   ./e2e/consumer-environment-bootstrap.sh --extra-file ord.yml --extra-file cat21.yml
#       (consumer-specific compose files layered on top of the base)
#
# Consumer CI workflows call this once before invoking Playwright,
# capturing the JSON to an env var or a file the test can read via
# `readConsumerEnvironment(...)` in `e2e/playwright/consumer-environment.ts`.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_BASE=( -f "$HERE/docker-compose.consumer-environment.yml" )
PROFILES=()
EXTRA_FILES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --with-redis)
      PROFILES+=( --profile redis )
      shift
      ;;
    --extra-file)
      EXTRA_FILES+=( -f "$2" )
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

COMPOSE=( docker compose "${COMPOSE_BASE[@]}" "${EXTRA_FILES[@]}" "${PROFILES[@]}" )
RPC="docker exec ordpool-e2e-consumer-bitcoind bitcoin-cli -regtest -rpcuser=ordpool -rpcpassword=ordpool"

# --- bring containers up if not already running ---
if ! docker ps --format '{{.Names}}' | grep -q 'ordpool-e2e-consumer-bitcoind'; then
  "${COMPOSE[@]}" up -d >&2
fi

# --- wait for bitcoind RPC to respond ---
for _ in $(seq 1 30); do
  if $RPC getblockchaininfo >/dev/null 2>&1; then break; fi
  sleep 1
done
$RPC getblockchaininfo >/dev/null

# --- generate or reuse a funded address (legacy/p2pkh so we have a known privkey) ---
$RPC createwallet ordpool-e2e false false "" false false >/dev/null 2>&1 || \
  $RPC loadwallet ordpool-e2e >/dev/null 2>&1 || true

ADDR=$($RPC -rpcwallet=ordpool-e2e getnewaddress "" legacy)
WIF=$($RPC -rpcwallet=ordpool-e2e dumpprivkey "$ADDR")

# --- mine 101 blocks so the coinbase reward matures ---
TIP=$($RPC getblockcount)
if [ "$TIP" -lt 101 ]; then
  NEEDED=$((101 - TIP))
  $RPC -rpcwallet=ordpool-e2e generatetoaddress "$NEEDED" "$ADDR" >/dev/null
fi

# --- wait for electrs to catch up to bitcoind's tip ---
TIP=$($RPC getblockcount)
for _ in $(seq 1 30); do
  if [ "$(curl -s http://localhost:3000/blocks/tip/height || echo 0)" -ge "$TIP" ]; then break; fi
  sleep 1
done

# --- wait for mariadb to accept connections ---
for _ in $(seq 1 30); do
  if docker exec ordpool-e2e-consumer-mariadb mariadb -uroot -pordpool -e 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done

REDIS_BLOCK="null"
if [ "${#PROFILES[@]}" -gt 0 ]; then
  for _ in $(seq 1 15); do
    if docker exec ordpool-e2e-consumer-redis redis-cli ping >/dev/null 2>&1; then break; fi
    sleep 1
  done
  REDIS_BLOCK='{"url":"redis://localhost:6379"}'
fi

# --- dump the environment descriptor ---
# Schema mirrors ConsumerEnvironmentUrls in e2e/playwright/consumer-environment.ts.
# When you add a field here, mirror it there too.
cat <<EOF
{
  "bitcoind": {
    "rpcUrl": "http://localhost:18443",
    "rpcUser": "ordpool",
    "rpcPassword": "ordpool",
    "zmqRawBlock": "tcp://localhost:28332",
    "zmqRawTx": "tcp://localhost:28333"
  },
  "electrs": {
    "httpUrl": "http://localhost:3000",
    "electrumRpcUrl": "tcp://localhost:50001"
  },
  "mariadb": {
    "host": "localhost",
    "port": 3306,
    "rootPassword": "ordpool",
    "ordpool": {"database": "mempool", "user": "mempool", "password": "mempool"},
    "cat21":   {"database": "cat21",   "user": "cat21",   "password": "cat21"}
  },
  "redis": ${REDIS_BLOCK},
  "fundedAddress": "${ADDR}",
  "fundedWif": "${WIF}"
}
EOF
