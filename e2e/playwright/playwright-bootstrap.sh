#!/usr/bin/env bash
# Stage the Xverse Chrome extension at e2e/extensions/xverse/ for
# Playwright to load via --load-extension. Runs only in CI; do not
# execute locally (we don't run unverified browser-extension code
# on dev machines). The repo never commits the build output.
#
# Source-of-truth: a private GitHub release in this same repo
# (ordpool-space/ordpool-sdk) holds the published .crx as an
# asset. We mirror it ourselves because:
#   - Chrome Web Store update endpoint returns 404 for non-Chrome
#     callers; can't scrape it from CI.
#   - Xverse GH releases tag versions but ship no build artifacts.
#   - Building from source needs @secretkeylabs/xverse-core, which
#     is published only to a private GH Package Registry (401).
#
# To bump the version: see the release notes on the tag below.
set -euo pipefail

XVERSE_VERSION="2.3.2"
RELEASE_TAG="xverse-extension-v${XVERSE_VERSION}"
ASSET_NAME="xverse-v${XVERSE_VERSION}.crx"
REPO="ordpool-space/ordpool-sdk"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="${SCRIPT_DIR}/../extensions/xverse"
CRX_FILE="$(mktemp /tmp/xverse.XXXXXX.crx)"

trap 'rm -f "$CRX_FILE"' EXIT

if [ -d "$EXT_DIR" ] && [ -f "$EXT_DIR/manifest.json" ]; then
  CACHED_VERSION="$(node -p "require('$EXT_DIR/manifest.json').version" 2>/dev/null || echo unknown)"
  if [ "$CACHED_VERSION" = "$XVERSE_VERSION" ]; then
    echo "Xverse v${XVERSE_VERSION} already unpacked at ${EXT_DIR}. Skipping."
    exit 0
  fi
  echo "Cached extension is v${CACHED_VERSION}, want v${XVERSE_VERSION}. Re-downloading."
fi

if [ -z "${GH_TOKEN:-}" ]; then
  echo "ERROR: GH_TOKEN env var required for gh release download" >&2
  exit 1
fi

echo "Downloading ${ASSET_NAME} from release ${RELEASE_TAG}..."
gh release download "$RELEASE_TAG" \
  --repo "$REPO" \
  --pattern "$ASSET_NAME" \
  --output "$CRX_FILE" \
  --clobber

echo "Downloaded $(wc -c < "$CRX_FILE") bytes."

MAGIC="$(head -c 4 "$CRX_FILE")"
if [ "$MAGIC" != "Cr24" ]; then
  echo "ERROR: downloaded file is not a CRX (got magic '$MAGIC')" >&2
  hexdump -C -n 32 "$CRX_FILE" >&2 || true
  exit 1
fi

rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
unzip -o -q "$CRX_FILE" -d "$EXT_DIR"

if [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "ERROR: unpack produced no manifest.json" >&2
  ls -la "$EXT_DIR" >&2
  exit 1
fi

EXT_VERSION="$(node -p "require('$EXT_DIR/manifest.json').version")"
echo "Unpacked Xverse v${EXT_VERSION} to ${EXT_DIR}"

if [ "$EXT_VERSION" != "$XVERSE_VERSION" ]; then
  echo "WARNING: manifest version ($EXT_VERSION) differs from pinned ($XVERSE_VERSION)" >&2
fi
