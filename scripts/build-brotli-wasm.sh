#!/usr/bin/env bash
# Build wasm/brotli_wasm_bg.wasm from wasm-src/brotli-ord.
#
# Builds inside Docker (see wasm-src/brotli-ord/Dockerfile) and copies the
# artifact out with `docker cp`, so nothing is installed on the host and no
# bind mount is needed. The crate's Cargo.lock pins brotli 8.0.2, the version
# cat21-ord resolves.
#
#   npm run build:brotli-wasm
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/wasm-src/brotli-ord"
tag="ordpool-sdk-brotli-ord:build"

docker build -t "$tag" "$src"
cid="$(docker create "$tag")"
trap 'docker rm -f "$cid" >/dev/null' EXIT
docker cp "$cid:/src/target/wasm32-unknown-unknown/release/brotli_ord.wasm" "$root/wasm/brotli_wasm_bg.wasm"
docker cp "$cid:/src/Cargo.lock" "$src/Cargo.lock"
shasum -a 256 "$root/wasm/brotli_wasm_bg.wasm"
