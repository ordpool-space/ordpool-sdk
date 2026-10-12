#!/usr/bin/env bash
# Bring up the consumer-environment compose stack — bitcoind, electrs,
# THE SUPERSET. Do NOT also run regtest-bootstrap.sh: that brings up a SECOND
# stack with its own bitcoind (in the same slot it collides on every host port,
# in another it takes a second slot of the machine's few). This script
# already creates the wallet (REGTEST_WALLET, default ordpool-e2e), mines, and emits the SAME
# fundedAddress / fundedWif that regtest-bootstrap.sh emits, so a consumer
# needs only this one.
#
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

# The stack runs in a machine-wide slot (e2e/stack-slot.sh): every host port
# and container name below comes from it, and no more than
# ORDPOOL_E2E_MAX_STACKS stacks run on this machine at once. A caller that
# acquired the slot exports E2E_SLOT; otherwise this script acquires one, and
# the stack keeps it until `node scripts/e2e-slots.mjs down <slot>`.
# shellcheck source=stack-slot.sh
. "$HERE/stack-slot.sh"
use_stack_slot consumer

# Host port electrs is published on. Container side stays 3000; only the host
# mapping moves.
ELECTRS_HTTP_URL="http://localhost:${E2E_ELECTRS_HOST_PORT}"
MARIADB_CONTAINER="${E2E_PREFIX}-consumer-mariadb"
REDIS_CONTAINER="${E2E_PREFIX}-consumer-redis"
COMPOSE_BASE=( -f "$HERE/docker-compose.consumer-environment.yml" )
PROFILES=()
EXTRA_FILES=()
BUILDX_CACHE=0
WITH_REDIS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --with-redis)
      PROFILES+=( --profile redis )
      WITH_REDIS=1
      shift
      ;;
    --with-cat21-ord)
      # Requires CAT21_ORD_SRC pointing at a cat21-ord checkout (or the
      # ../../cat21-ord workspace sibling). Consumers poll its /status on
      # E2E_ORD_HOST_PORT for readiness before running ord-dependent specs.
      PROFILES+=( --profile cat21-ord )
      shift
      ;;
    --with-ord-stock)
      # A full ord WITHOUT --index-cat21, on E2E_ORD_STOCK_HOST_PORT, so a consumer can read
      # real inscriptions / runes / sat ranges. Needed by any spec that
      # proves the funding-safety scan: cat21-ord indexes only cats and its
      # /output carries no `inscriptions` field, so pointing an ord base URL
      # there makes every inscribed coin read back clean and silently
      # disables the guard. Built from ORD_SRC (defaults to the cat21-ord
      # checkout, which is the same binary). Poll its /status for readiness.
      PROFILES+=( --profile ord-stock )
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

# `${a[@]+"${a[@]}"}`: an empty array under `set -u` is an unbound variable in
# bash 3.2 (macOS's /bin/bash), so expand each optional array only when set.
COMPOSE=( docker compose "${COMPOSE_BASE[@]}" ${EXTRA_FILES[@]+"${EXTRA_FILES[@]}"} ${PROFILES[@]+"${PROFILES[@]}"} )

# The electrs and ord checkouts the compose builds from, compared with
# build-pins.env. Paths as the compose resolves them: relative to e2e/.
# shellcheck source=build-pins.sh
. "$HERE/build-pins.sh"
check_build_pin ordpool-electrs "${ELECTRS_SRC:-$HERE/../../ordpool-electrs}" "$ORDPOOL_ELECTRS_SHA"
check_build_pin cat21-ord "${CAT21_ORD_SRC:-$HERE/../../cat21-ord}" "$CAT21_ORD_SHA"
BITCOIND_CONTAINER="$REGTEST_BITCOIND_CONTAINER"
RPC="docker exec $BITCOIND_CONTAINER bitcoin-cli -regtest -rpcuser=ordpool -rpcpassword=ordpool"
# The wallet name these helpers spend from. A consumer stack brings this
# compose up under its own project prefix, so the name must match what its
# regtest-helpers use (REGTEST_WALLET there).
WALLET="${REGTEST_WALLET:-ordpool-e2e}"

# --- bring containers up if not already running ---
if ! docker ps --format '{{.Names}}' | grep -qx "$BITCOIND_CONTAINER"; then
  if [ "$BUILDX_CACHE" = 1 ]; then
    # Build every buildable service of the ACTIVE profile set through
    # buildx bake so the gha overlay's cache_from/to take effect (electrs
    # always; cat21-ord when --with-cat21-ord is on); bake loads the
    # images (they have `image:` names) for the following --no-build up.
    COMPOSE_BAKE=true "${COMPOSE[@]}" build >&2
    "${COMPOSE[@]}" up -d --no-build >&2
  else
    # The MariaDB image carries the init scripts (COPY, not a bind mount; see
    # the compose file). `up` reuses an existing image, so build it first:
    # cached, it takes a moment, and an edited script always reaches the stack.
    "${COMPOSE[@]}" build mariadb >&2
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
$RPC -named createwallet wallet_name="$WALLET" load_on_startup=true >/dev/null 2>&1 || \
  $RPC loadwallet "$WALLET" >/dev/null 2>&1 || true

MINING_ADDR=$($RPC -rpcwallet="$WALLET" getnewaddress)

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
  $RPC -rpcwallet="$WALLET" generatetoaddress "$NEEDED" "$MINING_ADDR" >/dev/null
fi

# --- and keep mining until the wallet actually has something to spend ---
# 101 blocks matures the first coinbase only on a chain that started empty. A
# chain that has been run against before can sit above 101 with every mature
# coin already spent; every spec then fails on "Insufficient funds" with
# nothing pointing at the wallet. Same hardening as regtest-bootstrap.sh.
for _ in $(seq 1 20); do
  if [ "$($RPC -rpcwallet="$WALLET" getbalance | tr -d '.0')" != "" ]; then break; fi
  $RPC -rpcwallet="$WALLET" generatetoaddress 20 "$MINING_ADDR" >/dev/null
done
if [ "$($RPC -rpcwallet="$WALLET" getbalance | tr -d '.0')" = "" ]; then
  echo "consumer-environment-bootstrap: wallet $WALLET has no spendable balance after mining; aborting" >&2
  exit 1
fi

# --- wait for electrs to catch up to bitcoind's tip ---
TIP=$($RPC getblockcount)
for _ in $(seq 1 30); do
  if [ "$(curl -s "${ELECTRS_HTTP_URL}/blocks/tip/height" || echo 0)" -ge "$TIP" ]; then break; fi
  sleep 1
done

# --- wait for mariadb to serve both consumer users over TCP ---
# Logging in as each consumer user over 127.0.0.1 proves the init scripts ran
# (they create the users) and the real server is up: the entrypoint runs the
# scripts against a temporary server without networking, which a root login
# over the socket would already reach.
mariadb_users_ready() {
  docker exec "$MARIADB_CONTAINER" mariadb -h127.0.0.1 -umempool -pmempool mempool -e 'SELECT 1' >/dev/null 2>&1 &&
    docker exec "$MARIADB_CONTAINER" mariadb -h127.0.0.1 -ucat21 -pcat21 cat21 -e 'SELECT 1' >/dev/null 2>&1
}
for _ in $(seq 1 60); do
  if mariadb_users_ready; then break; fi
  sleep 1
done
if ! mariadb_users_ready; then
  echo "consumer-environment-bootstrap: $MARIADB_CONTAINER does not let users mempool and cat21 log in over TCP; its init scripts did not run:" >&2
  if ! docker exec "$MARIADB_CONTAINER" mariadb -h127.0.0.1 -ucat21 -pcat21 cat21 -e 'SELECT 1' >&2; then
    echo "consumer-environment-bootstrap: the cat21 login above is the one that fails" >&2
  fi
  if ! docker exec "$MARIADB_CONTAINER" ls -la /docker-entrypoint-initdb.d >&2; then
    echo "consumer-environment-bootstrap: could not list the init scripts in $MARIADB_CONTAINER" >&2
  fi
  exit 1
fi

REDIS_BLOCK="null"
if [ "$WITH_REDIS" = 1 ]; then
  for _ in $(seq 1 15); do
    if docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; then break; fi
    sleep 1
  done
  REDIS_BLOCK="{\"url\":\"redis://localhost:${E2E_REDIS_HOST_PORT}\"}"
fi

SLOT_ENV_JSON="$(node "$STACK_SLOTS_CLI" env --slot "$E2E_SLOT" --kind consumer --format json)"

# --- dump the environment descriptor ---
# Schema mirrors ConsumerEnvironmentUrls in e2e/playwright/consumer-environment.ts.
# When you add a field here, mirror it there too.
cat <<EOF
{
  "slot": ${E2E_SLOT},
  "prefix": "${E2E_PREFIX}",
  "env": ${SLOT_ENV_JSON},
  "bitcoind": {
    "rpcUrl": "http://localhost:${E2E_BITCOIND_RPC_HOST_PORT}",
    "rpcUser": "ordpool",
    "rpcPassword": "ordpool",
    "zmqRawBlock": "tcp://localhost:${E2E_ZMQ_RAWBLOCK_HOST_PORT}",
    "zmqRawTx": "tcp://localhost:${E2E_ZMQ_RAWTX_HOST_PORT}",
    "container": "${BITCOIND_CONTAINER}"
  },
  "electrs": {
    "httpUrl": "${ELECTRS_HTTP_URL}",
    "electrumRpcUrl": "tcp://localhost:${E2E_ELECTRUM_HOST_PORT}"
  },
  "mariadb": {
    "host": "localhost",
    "port": ${E2E_MARIADB_HOST_PORT},
    "rootPassword": "ordpool",
    "ordpool": {"database": "mempool", "user": "mempool", "password": "mempool"},
    "cat21":   {"database": "cat21",   "user": "cat21",   "password": "cat21"}
  },
  "redis": ${REDIS_BLOCK},
  "fundedAddress": "${ADDR}",
  "fundedWif": "${WIF}"
}
EOF

if [ "$STACK_SLOT_ACQUIRED_HERE" = 1 ]; then
  echo "consumer-environment-bootstrap: the stack holds slot $E2E_SLOT ($E2E_PREFIX) until it is torn down." >&2
  echo "  its environment, for the specs: eval \"\$(node $STACK_SLOTS_CLI env --slot $E2E_SLOT --kind consumer)\"" >&2
  echo "  tear it down:                   node $STACK_SLOTS_CLI down $E2E_SLOT" >&2
fi
