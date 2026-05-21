#!/usr/bin/env bash
# Build the Xverse extension from source and stage it at
# e2e/extensions/xverse/ so Playwright can load it via
# --load-extension. Runs only in CI; do not execute locally
# (we don't run unverified browser-extension code on dev
# machines). The repo never commits the build output.
#
# The Chrome Web Store update endpoint stopped serving .crx
# blobs to arbitrary callers (404 on every variant of the
# query string), and Xverse's GitHub releases tag versions
# but ship no build artifacts. Building from source is the
# only path that yields a reproducible extension.
#
# License: Xverse's repo is source-available under a
# non-commercial license. CI tests for our SDK fall within
# the "research / hobby / <1000 MAU" non-commercial use
# grant. We do not redistribute the build.
set -euo pipefail

XVERSE_REPO="https://github.com/secretkeylabs/xverse-web-extension.git"
XVERSE_REF="v0.54.2"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="${SCRIPT_DIR}/../extensions/xverse"
SRC_DIR="${SCRIPT_DIR}/../extensions/.xverse-src"

if [ -d "$EXT_DIR" ] && [ -f "$EXT_DIR/manifest.json" ]; then
  CACHED_VERSION="$(node -p "require('$EXT_DIR/manifest.json').version" 2>/dev/null || echo unknown)"
  echo "Xverse already built at ${EXT_DIR} (v${CACHED_VERSION}). Skipping rebuild."
  exit 0
fi

mkdir -p "$(dirname "$SRC_DIR")"
rm -rf "$SRC_DIR" "$EXT_DIR"

echo "Cloning ${XVERSE_REPO} @ ${XVERSE_REF}"
git clone --depth=1 --branch "$XVERSE_REF" "$XVERSE_REPO" "$SRC_DIR"

echo "Installing Xverse dependencies (this is slow)..."
( cd "$SRC_DIR" && npm ci --no-audit --no-fund --legacy-peer-deps )

echo "Building Xverse extension..."
( cd "$SRC_DIR" && npm run build )

if [ ! -d "$SRC_DIR/build" ] || [ ! -f "$SRC_DIR/build/manifest.json" ]; then
  echo "ERROR: Xverse build produced no usable output" >&2
  ls -la "$SRC_DIR" >&2
  exit 1
fi

mkdir -p "$EXT_DIR"
cp -R "$SRC_DIR/build/." "$EXT_DIR/"

EXT_VERSION="$(node -p "require('$EXT_DIR/manifest.json').version")"
echo "Built Xverse v${EXT_VERSION}, staged to ${EXT_DIR}"
