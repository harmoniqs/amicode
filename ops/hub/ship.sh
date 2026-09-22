#!/bin/bash
# amicode ops/hub/ship.sh — publish the built app to the fleet's three
# destinations and VERIFY. Born from #1310 (the CSS the hub never
# received), blinded AGAIN by #1314 (LAZY CHUNKS: the new-session page
# is code-split — dynamically imported from the main JS, invisible to
# index.html — its chunk never shipped, the hub served SPA HTML for the
# missing .js, and the module parser threw SyntaxError at every boot:
# the "stuck loading a new session" arc). The ritual now ships the FULL
# assets directory: hashed asset names are immutable, rsync transfers
# only new files, and a dry-run diff verifies the hub exactly matches
# the build — statics, lazy chunks, fonts, everything.
#
# Destinations:
#   1. hub   ~/.amico/server/app-dist/   (index.html + full assets rsync)
#   2. shelf ~/.amico/shelf/app-dist/     (full rsync)
#   3. extension dist/app                 (full rsync)
#
# Usage: ops/hub/ship.sh [dist-dir]   (default: the materialized app dist)
set -euo pipefail
DIST="${1:-$(cd "$(dirname "$0")/../../packages/app-bundle/.materialized/packages/app/dist" && pwd)}"
HUB=amico-hub
HUB_DIST='.amico/server/app-dist'

[ -f "$DIST/index.html" ] || { echo "no index.html in $DIST — build first"; exit 1; }

echo "== shipping index.html + the FULL assets directory to hub =="
scp "$DIST/index.html" "$HUB:$HUB_DIST/index.html"
rsync -a --exclude="*.map" "$DIST/assets/" "$HUB:$HUB_DIST/assets/"  # maps: devtools-only, they time out over the tunnel
echo "  assets synced: $(ls "$DIST/assets" | grep -v '.map$' | wc -l | tr -d ' ') build files"

echo "== full rsync: shelf + extension dist/app =="
rsync -a "$DIST/" "$HOME/.amico/shelf/app-dist/"
rsync -a "$DIST/" "$HOME/.vscode/extensions/harmoniqs.amicode-0.3.7/dist/app/"

echo "== verify hub completeness (dry-run diff: build assets vs hub assets) =="
MISSING=$(rsync -ain --exclude="*.map" "$DIST/assets/" "$HUB:$HUB_DIST/assets/" | grep -c '^<f' || true)
echo "  hub assets missing vs build: $MISSING"
if [ "$MISSING" != "0" ]; then
  echo "  VERIFICATION FAILED — files missing on the hub:" >&2
  rsync -ain --exclude="*.map" "$DIST/assets/" "$HUB:$HUB_DIST/assets/" | grep '^<f' | head -5 >&2
  exit 1
fi

echo "shipped: $(grep -oE 'index-[A-Za-z0-9_-]+\.js' "$DIST/index.html" | head -1)"
