#!/bin/bash
# Packages game data with Emscripten's file_packager, mounted at /data:
#   demo-data.{data,js}  the demo (see fetch_demo_data.sh), ready to play
#   base-data.{data,js}  this repository's game files (SE1_10b.gro, scripts, ...),
#                        used under game files that the player provides
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$WEB_DIR")"
DEMO_DIR="$WEB_DIR/build/demo-data"
BASE_DIR="$WEB_DIR/build/base-data"
OUT_DIR="${1:-$WEB_DIR/build/dist}"

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
python3 "$FILE_PACKAGER" demo-data.data --preload "$DEMO_DIR@/data" \
  --use-preload-cache --js-output=demo-data.js
python3 "$FILE_PACKAGER" base-data.data --preload "$BASE_DIR@/data" \
  --use-preload-cache --js-output=base-data.js
ls -la "$OUT_DIR"/*-data.*
