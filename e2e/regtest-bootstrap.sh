#!/usr/bin/env bash
# Bring up bitcoind + electrs (regtest) and mine 101 blocks so the
# coinbase rewards mature. Prints the funded address + private key
# on stdout (as JSON) so the E2E suite can pick them up.
#
# Usage:
#   ./e2e/regtest-bootstrap.sh
#   eval $(./e2e/regtest-bootstrap.sh | jq -r '"export REGTEST_FUNDED_ADDR=" + .address + " REGTEST_FUNDED_WIF=" + .wif')

set -euo pipefail

COMPOSE="docker compose -f $(dirname "$0")/docker-compose.regtest.yml"
RPC="docker exec ordpool-e2e-bitcoind bitcoin-cli -regtest -rpcuser=ordpool -rpcpassword=ordpool"

# --- bring containers up if not already running ---
if ! docker ps --format '{{.Names}}' | grep -q 'ordpool-e2e-bitcoind'; then
  $COMPOSE up -d >&2
fi

# --- wait for bitcoind RPC to respond ---
for _ in $(seq 1 30); do
  if $RPC getblockchaininfo >/dev/null 2>&1; then break; fi
  sleep 1
done
$RPC getblockchaininfo >/dev/null

# --- generate or reuse a funded address ---
# Create a fresh legacy address (p2pkh) so we have a known privkey to
# dump and use in the SDK signer tests. SegWit/Taproot funding is
# generated on the fly per-test; this bootstrap only needs ANY UTXO
# to seed the mempool with.
# Bitcoin Core 28+ defaults to descriptor wallets; dumpprivkey only
# works on legacy ones. Pass `descriptors=false` explicitly.
$RPC -named createwallet wallet_name=ordpool-e2e descriptors=false load_on_startup=true >/dev/null 2>&1 || \
  $RPC loadwallet ordpool-e2e >/dev/null 2>&1 || true

ADDR=$($RPC -rpcwallet=ordpool-e2e getnewaddress "" legacy)
WIF=$($RPC -rpcwallet=ordpool-e2e dumpprivkey "$ADDR")

# --- mine 101 blocks to mature the coinbase ---
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

# --- emit the credentials as JSON ---
BALANCE=$($RPC -rpcwallet=ordpool-e2e getbalance)
jq -n \
  --arg address "$ADDR" \
  --arg wif "$WIF" \
  --arg balance "$BALANCE" \
  --arg tipHeight "$TIP" \
  '{ address: $address, wif: $wif, balance: $balance, tipHeight: $tipHeight }'
