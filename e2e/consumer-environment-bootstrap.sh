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
#   ./e2e/consumer-environment-bootstrap.sh --buildx-cache
#       (CI-only: build electrs through buildx bake with a type=gha cache
#        so an unchanged ordpool-electrs source reuses the compiled image
#        instead of recompiling Rust ~10 min every run — see
#        docker-compose.consumer-gha-cache.yml. Requires a buildx builder
#        + the Actions runtime env, which the caller sets up.)
#
# Consumer CI workflows call this once before invoking Playwright,
# capturing the JSON to an env var or a file the test can read via
# `readConsumerEnvironment(...)` in `e2e/playwright/consumer-environment.ts`.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_BASE=( -f "$HERE/docker-compose.consumer-environment.yml" )
PROFILES=()
EXTRA_FILES=()
BUILDX_CACHE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --with-redis)
      PROFILES+=( --profile redis )
      shift
      ;;
    --with-cat21-ord)
      # Requires CAT21_ORD_SRC pointing at a cat21-ord checkout (or the
      # ../../cat21-ord workspace sibling). Consumers poll :8080/status
      # for readiness before running ord-dependent specs.
      PROFILES+=( --profile cat21-ord )
      shift
      ;;
    --extra-file)
      EXTRA_FILES+=( -f "$2" )
      shift 2
      ;;
    --buildx-cache)
      BUILDX_CACHE=1
      EXTRA_FILES+=( -f "$HERE/docker-compose.consumer-gha-cache.yml" )
      shift
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
  if [ "$BUILDX_CACHE" = 1 ]; then
    # Build every buildable service of the ACTIVE profile set through
    # buildx bake so the gha overlay's cache_from/to take effect (electrs
    # always; cat21-ord when --with-cat21-ord is on); bake loads the
    # images (they have `image:` names) for the following --no-build up.
    COMPOSE_BAKE=true "${COMPOSE[@]}" build >&2
    "${COMPOSE[@]}" up -d --no-build >&2
  else
    "${COMPOSE[@]}" up -d >&2
  fi
fi

# --- wait for bitcoind RPC to respond ---
for _ in $(seq 1 30); do
  if $RPC getblockchaininfo >/dev/null 2>&1; then break; fi
  sleep 1
done
$RPC getblockchaininfo >/dev/null

# --- bitcoind wallet for mining + funding sends ---
# A descriptor wallet (the only kind Bitcoin Core 29+ can create — the
# legacy/BDB backend was removed). It owns the mined coinbases the
# consumer specs spend from; it does NOT hold the funder signing key.
$RPC -named createwallet wallet_name=ordpool-e2e load_on_startup=true >/dev/null 2>&1 || \
  $RPC loadwallet ordpool-e2e >/dev/null 2>&1 || true

MINING_ADDR=$($RPC -rpcwallet=ordpool-e2e getnewaddress)

# --- funder keypair the consumer specs sign with ---
# Supplied as a fixed regtest keypair instead of dumped from bitcoind:
# descriptor wallets can't export a WIF and legacy wallets are gone on
# Core 29+. Throwaway regtest-only key (deterministic, zero real value).
# Same key the SDK's own regtest-bootstrap.sh emits.
ADDR="bcrt1qw5pw5evmamu6dm5qze7a8yg07wmamvzpq3huc3"
WIF="cNvr6PMcpe862cZuaxP4kqMDodEUxLXSW7DGxW6c7PiYTZ5sWQcK"

# --- mine 101 blocks so the coinbase reward matures ---
TIP=$($RPC getblockcount)
if [ "$TIP" -lt 101 ]; then
  NEEDED=$((101 - TIP))
  $RPC -rpcwallet=ordpool-e2e generatetoaddress "$NEEDED" "$MINING_ADDR" >/dev/null
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
