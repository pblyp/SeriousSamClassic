#!/bin/bash
# Builds the web version of Serious Sam: The First Encounter into web/build/dist.
#
#   web/build.sh [Release|RelWithDebInfo|Debug] [jspi|asyncify|all]
#
# Needs an activated emsdk (source <emsdk>/emsdk_env.sh), cmake, ninja, flex, bison and node.
# The demo data is fetched and packaged on the first run (see fetch_demo_data.sh).
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$WEB_DIR")"
SRC_DIR="$REPO_DIR/SamTFE/Sources"
BUILD_DIR="$WEB_DIR/build"
DIST_DIR="$BUILD_DIR/dist"
BUILD_TYPE="${1:-Release}"
VARIANTS="${2:-all}"
if [ "$VARIANTS" = "all" ]; then
  VARIANTS="jspi asyncify"
fi

if ! command -v emcmake >/dev/null; then
  echo "Activate emsdk first (source <emsdk>/emsdk_env.sh)" >&2
  exit 1
fi
# macOS ships an ancient bison; prefer Homebrew's
for d in /opt/homebrew/opt/bison/bin /opt/homebrew/opt/flex/bin /usr/local/opt/bison/bin /usr/local/opt/flex/bin; do
  if [ -d "$d" ]; then PATH="$d:$PATH"; fi
done

# 1. the entity class compiler runs on the build machine
NATIVE_DIR="$BUILD_DIR/ecc"
cmake -S "$SRC_DIR" -B "$NATIVE_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release -DTFE=TRUE >/dev/null
cmake --build "$NATIVE_DIR" --target ecc
ECC="$NATIVE_DIR/ecc"

# 2. the engine, once per way of yielding to the browser
mkdir -p "$DIST_DIR"
for variant in $VARIANTS; do
  out="$BUILD_DIR/wasm-$variant"
  emcmake cmake -S "$SRC_DIR" -B "$out" -G Ninja -DCMAKE_BUILD_TYPE="$BUILD_TYPE" -DTFE=TRUE \
    -DECC="$ECC" -DWEB_ASYNC="$(echo "$variant" | tr a-z A-Z)" >/dev/null
  cmake --build "$out" --target SeriousSam
  mkdir -p "$DIST_DIR/$variant"
  cp "$out/serioussam.js" "$out/serioussam.wasm" "$DIST_DIR/$variant/"
done

# 3. the page and the demo data (SITE_URL: where the site will be, for demo.torrent's web seed)
cp "$WEB_DIR/shell/"* "$DIST_DIR/"
if [ ! -f "$DIST_DIR/demo-page.torrent" ] || [ ! -f "$DIST_DIR/base-data.data" ]; then
  if [ ! -d "$BUILD_DIR/demo-data" ]; then
    "$WEB_DIR/fetch_demo_data.sh"
  fi
  "$WEB_DIR/package_demo.sh" "$DIST_DIR" "${SITE_URL:-}"
fi

echo "Built into $DIST_DIR"
