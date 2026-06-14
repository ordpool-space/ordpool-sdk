#!/usr/bin/env bash
# Stage a Chrome extension at e2e/extensions/<wallet>/ for Playwright
# to load via --load-extension. Runs only in CI; do not execute
# locally (we don't run unverified browser-extension code on dev
# machines). The repo never commits the build output.
#
# Source-of-truth: private GitHub releases on ordpool-space/ordpool-sdk
# hold the published .crx files as assets. We mirror them ourselves
# because:
#   - Chrome Web Store update endpoint returns 404 for non-Chrome
#     callers; can't scrape it from CI.
#   - Vendor GH releases tag versions but ship no build artifacts.
#   - Building from source is gated (Xverse needs a private GH
#     Package Registry; others vary).
#
# Usage: bash playwright-bootstrap.sh <wallet>
#
# Supported wallets: xverse, unisat, leather.
# To bump a version: edit the per-wallet block below, then create a
# new release tagged <wallet>-extension-v<version> with the .crx
# attached on ordpool-space/ordpool-sdk.
set -euo pipefail

WALLET="${1:-}"
if [ -z "$WALLET" ]; then
  echo "ERROR: usage: $0 <wallet>" >&2
  echo "       supported: xverse, unisat, leather" >&2
  exit 2
fi

case "$WALLET" in
  xverse)
    VERSION="2.3.2"
    ASSET_NAME="xverse-v${VERSION}.crx"
    ;;
  unisat)
    VERSION="1.7.15"
    ASSET_NAME="unisat-v${VERSION}.crx"
    ;;
  leather)
    VERSION="6.102.0"
    ASSET_NAME="leather-v${VERSION}.crx"
    ;;
  okx)
    VERSION="4.1.0"
    ASSET_NAME="okx-wallet-v${VERSION}.crx"
    ;;
  phantom)
    VERSION="26.16.0"
    ASSET_NAME="phantom-v${VERSION}.crx"
    ;;
  wizz)
    VERSION="2.13.4"
    ASSET_NAME="wizz-wallet-v${VERSION}.crx"
    ;;
  oyl)
    VERSION="1.17.1"
    ASSET_NAME="oyl-wallet-v${VERSION}.crx"
    ;;
  alby)
    VERSION="3.14.2"
    ASSET_NAME="alby-bitcoin-wallet-v${VERSION}.crx"
    ;;
  cat21wallet)
    # Cat21 Wallet — our own fork of Leather. Built from source in
    # the cat21-wallet repo's apps/extension/dist/ (no CRX
    # packaging in the wallet's CI yet); CI publishes the same
    # bytes attested via gh attestation under the release tag
    # below.
    VERSION="6.103.0.675"
    ASSET_NAME="cat21-wallet-v${VERSION}.crx"
    ;;
  *)
    echo "ERROR: unknown wallet '$WALLET'. Supported: xverse, unisat, leather, okx, phantom, wizz, oyl, alby, cat21wallet." >&2
    exit 2
    ;;
esac

RELEASE_TAG="${WALLET}-extension-v${VERSION}"
REPO="ordpool-space/ordpool-sdk"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="${SCRIPT_DIR}/../extensions/${WALLET}"
CRX_FILE="$(mktemp "/tmp/${WALLET}.XXXXXX.crx")"

trap 'rm -f "$CRX_FILE"' EXIT

if [ -d "$EXT_DIR" ] && [ -f "$EXT_DIR/manifest.json" ]; then
  CACHED_VERSION="$(node -p "require('$EXT_DIR/manifest.json').version" 2>/dev/null || echo unknown)"
  if [ "$CACHED_VERSION" = "$VERSION" ]; then
    echo "${WALLET} v${VERSION} already unpacked at ${EXT_DIR}. Skipping."
    exit 0
  fi
  echo "Cached extension is v${CACHED_VERSION}, want v${VERSION}. Re-downloading."
fi

if [ "$WALLET" = "cat21wallet" ] && [ -n "${CAT21_WALLET_LOCAL_DIST:-}" ]; then
  # Source-built dist override. The cat21-wallet repo ships an
  # already-unpacked `apps/extension/dist/` after `pnpm build:extension`.
  # When CI builds the wallet alongside the SDK (or a dev wants to
  # iterate locally without publishing a CRX), point CAT21_WALLET_LOCAL_DIST
  # at that directory and we copy it straight in. Skips the CRX
  # download + unpack path entirely.
  if [ ! -f "${CAT21_WALLET_LOCAL_DIST}/manifest.json" ]; then
    echo "ERROR: CAT21_WALLET_LOCAL_DIST=${CAT21_WALLET_LOCAL_DIST} does not contain a manifest.json" >&2
    exit 1
  fi
  echo "Copying cat21-wallet dist from ${CAT21_WALLET_LOCAL_DIST}"
  rm -rf "$EXT_DIR"
  mkdir -p "$EXT_DIR"
  cp -R "${CAT21_WALLET_LOCAL_DIST}/." "$EXT_DIR/"
  EXT_VERSION="$(node -p "require('$EXT_DIR/manifest.json').version")"
  echo "Staged cat21-wallet v${EXT_VERSION} to ${EXT_DIR}"
  exit 0
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
# unzip exits 1 on warnings (here: the CRX header is "extra bytes
# at beginning of zipfile") even though all files extract correctly.
# Tolerate the warning; we verify the manifest is present afterwards.
unzip -o -q "$CRX_FILE" -d "$EXT_DIR" || true

if [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "ERROR: unpack produced no manifest.json" >&2
  ls -la "$EXT_DIR" >&2
  exit 1
fi

EXT_VERSION="$(node -p "require('$EXT_DIR/manifest.json').version")"
echo "Unpacked ${WALLET} v${EXT_VERSION} to ${EXT_DIR}"

if [ "$EXT_VERSION" != "$VERSION" ]; then
  echo "WARNING: manifest version ($EXT_VERSION) differs from pinned ($VERSION)" >&2
fi
