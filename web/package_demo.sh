#!/bin/bash
# Prepares the game data for the page:
#   demo/, demo*.torrent, demo-torrent.json
#                        the demo (see fetch_demo_data.sh), downloaded with WebTorrent
#                        (from other players, and from these files as web seed)
#   base-data.{data,js}  this repository's game files (SE1_10b.gro, scripts, ...) packaged
#                        with Emscripten's file_packager, used under game files that the
#                        player provides
#
#   package_demo.sh [dist dir] [site url]
#
# The site URL (e.g. https://user.github.io/SeriousSamClassic/) is written into
# demo.torrent as web seed for BitTorrent clients; the page doesn't need it.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$WEB_DIR")"
DEMO_DIR="$WEB_DIR/build/demo-data"
BASE_DIR="$WEB_DIR/build/base-data"
OUT_DIR="${1:-$WEB_DIR/build/dist}"
SITE_URL="${2:-}"

if [ ! -d "$DEMO_DIR" ]; then
  echo "Run fetch_demo_data.sh first" >&2
  exit 1
fi
if [ -z "${EMSDK:-}" ]; then
  echo "Activate emsdk first (source <emsdk>/emsdk_env.sh)" >&2
  exit 1
fi
FILE_PACKAGER="$EMSDK/upstream/emscripten/tools/file_packager.py"

# the repository's files that the engine needs besides the original game data
rm -rf "$BASE_DIR"
mkdir -p "$BASE_DIR"
rsync -a --exclude 'Sources' --exclude 'Bin' --exclude 'Tools.Win32' --exclude 'GameAgent' \
  --exclude 'Mods' --exclude 'Demos' --exclude '*.desktop' --exclude 'serioussam.png' \
  "$REPO_DIR/SamTFE/" "$BASE_DIR/"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"
python3 "$FILE_PACKAGER" base-data.data --preload "$BASE_DIR@/data" \
  --use-preload-cache --js-output=base-data.js

# the demo's files as they are (each one is well below GitHub Pages' 100 MB limit)
rm -f demo-data.data demo-data.js
rsync -a --delete --exclude '.DS_Store' "$DEMO_DIR/" "$OUT_DIR/demo/"
(cd "$WEB_DIR/tools" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
node "$WEB_DIR/tools/make_torrent.mjs" "$OUT_DIR" "$SITE_URL"
cp "$WEB_DIR/tools/node_modules/webtorrent/dist/webtorrent.min.js" "$OUT_DIR/"
ls -la "$OUT_DIR"/base-data.* "$OUT_DIR"/demo*
