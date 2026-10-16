#!/bin/bash
# Downloads the official Serious Sam: The First Encounter demo (Windows) and
# the 1.05 patch from archive.org, extracts them and stages the game data
# (the same overlay as build-linux64demo.sh) into web/build/demo-data.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$WEB_DIR")"
BUILD_DIR="$WEB_DIR/build"
DL_DIR="$BUILD_DIR/downloads"
SRC_DIR="$BUILD_DIR/demo-src"
OUT_DIR="$BUILD_DIR/demo-data"

DEMO_URL="https://archive.org/download/SeriousSamDemo/SeriousSamDemo.exe"
PATCH_URL="https://archive.org/download/SeriousSamPatches/serioussampatch105_usa.exe"

SEVENZIP="$(command -v 7zz || command -v 7z || true)"
if [ -z "$SEVENZIP" ]; then
  echo "7-Zip is required (brew install sevenzip / apt install 7zip)" >&2
  exit 1
fi

mkdir -p "$DL_DIR"
fetch() {
  local url="$1" file="$DL_DIR/$(basename "$1")"
  if [ ! -s "$file" ]; then
    echo "Downloading $url"
    curl -fL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
}
fetch "$DEMO_URL"
fetch "$PATCH_URL"

# Verify checksums if they have been recorded.
if [ -f "$WEB_DIR/demo_data.sha256" ]; then
  (cd "$DL_DIR" && shasum -a 256 -c "$WEB_DIR/demo_data.sha256")
fi

rm -rf "$SRC_DIR" "$OUT_DIR"
mkdir -p "$SRC_DIR" "$OUT_DIR"
(cd "$SRC_DIR" && "$SEVENZIP" x -y "$DL_DIR/SeriousSamDemo.exe" >/dev/null)
(cd "$SRC_DIR" && "$SEVENZIP" x -y "$DL_DIR/serioussampatch105_usa.exe" >/dev/null)

# Start from the repository's game directory (SE1_10b.gro, Scripts, Controls...),
# then overlay the demo's Disk1 contents and the patch.
rsync -a --exclude 'Sources' --exclude 'Bin' --exclude 'Tools.Win32' \
  --exclude '*.desktop' --exclude 'serioussam.png' \
  "$REPO_DIR/SamTFE/" "$OUT_DIR/"
if [ -d "$SRC_DIR/Disk1" ]; then
  rsync -a "$SRC_DIR/Disk1/" "$OUT_DIR/"
fi
rsync -a --exclude 'Disk1' "$SRC_DIR/" "$OUT_DIR/"
# The repo's GL settings are the ones the engine expects.
rm -rf "$OUT_DIR/Scripts/GLSettings"
rsync -a "$REPO_DIR/SamTFE/Scripts/GLSettings/" "$OUT_DIR/Scripts/GLSettings/"

# Remove Windows-only files.
# Localized text/sound packs, the master server agent and mods are not needed.
(cd "$OUT_DIR" && rm -rf Bin Tools.Win32 Locales GameAgent Mods && \
  find . -maxdepth 1 -type f \( -iname '*.exe' -o -iname '*.ex_' -o -iname '*.bmp' \
    -o -iname '*.inx' -o -iname '*.hdr' -o -iname '*.bin' -o -iname '*.cab' \
    -o -iname '*.ini' -o -iname '*.log' -o -iname '*.dll' \) -delete)

echo "Demo data staged in $OUT_DIR"
du -sh "$OUT_DIR"
