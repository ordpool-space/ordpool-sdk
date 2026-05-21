#!/usr/bin/env bash
# Downloads + unpacks the published Xverse Chrome extension from the
# Chrome Web Store update endpoint. Runs only in CI; do not execute
# locally (we don't run unverified browser-extension binaries on
# dev machines). The repo never commits the .crx itself.
#
# The Chrome Web Store doesn't expose direct .crx URLs, so we hit
# the same update XML endpoint that the browser uses on install.
# The endpoint returns a 302 redirect to the actual .crx blob.
#
# CRX file format: [magic "Cr24"][u32 version][u32 header_len]
# [header bytes][zip payload]. `unzip` finds the central directory
# at the end of the file and ignores the CRX prefix, so we can
# unzip the .crx directly to the target dir.
set -euo pipefail

XVERSE_ID="idnnbhkphhpkkjpiopdliebdejnmdmco"
# The Chrome update endpoint expects the same query string a real
# Chrome install would send. Stripping the OS / arch / prod fields
# yields 404. The full set below is the public-documented format.
PRODVERSION="131.0.6778.86"
CRX_URL="https://clients2.google.com/service/update2/crx?response=redirect&os=linux&arch=x64&os_arch=x86_64&nacl_arch=x86-64&prod=chromecrx&prodchannel=stable&prodversion=${PRODVERSION}&lang=en-US&acceptformat=crx2,crx3&x=id%3D${XVERSE_ID}%26installsource%3Dondemand%26uc"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="${SCRIPT_DIR}/../extensions/xverse"
CRX_FILE="$(mktemp /tmp/xverse.XXXXXX.crx)"

trap 'rm -f "$CRX_FILE"' EXIT

echo "Downloading Xverse .crx from Chrome Web Store update endpoint..."
echo "URL: ${CRX_URL}"

# -L follows the 302 redirect from the update XML endpoint to the
# actual .crx blob. -w prints the final HTTP code + URL so we can
# diagnose 404 / 403 / blob-empty failures.
HTTP_CODE="$(curl -sSL --retry 3 --retry-delay 2 \
  -o "$CRX_FILE" \
  -w '%{http_code} %{url_effective}\n' \
  "$CRX_URL" || true)"
echo "Final response: ${HTTP_CODE}"
echo "Downloaded $(wc -c < "$CRX_FILE") bytes."

if [ ! -s "$CRX_FILE" ]; then
  echo "ERROR: downloaded 0 bytes" >&2
  exit 1
fi

# Verify the CRX magic so we don't try to unzip an HTML error page.
MAGIC="$(head -c 4 "$CRX_FILE")"
if [ "$MAGIC" != "Cr24" ]; then
  echo "ERROR: downloaded file is not a CRX (got magic '$MAGIC')" >&2
  hexdump -C -n 32 "$CRX_FILE" >&2 || true
  exit 1
fi

rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
# `unzip` scans for the central directory at the end of the file
# and tolerates the non-zip CRX prefix.
unzip -o -q "$CRX_FILE" -d "$EXT_DIR"

if [ ! -f "$EXT_DIR/manifest.json" ]; then
  echo "ERROR: unpack produced no manifest.json" >&2
  ls -la "$EXT_DIR" >&2
  exit 1
fi

EXT_VERSION="$(node -p "require('$EXT_DIR/manifest.json').version")"
echo "Unpacked Xverse v${EXT_VERSION} to ${EXT_DIR}"
