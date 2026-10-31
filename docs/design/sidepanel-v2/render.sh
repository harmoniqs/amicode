#!/usr/bin/env bash
# Render every mock to PNG in both themes with headless Chromium.
#   ./render.sh [page ...]      (defaults to all *.html except index)
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | tail -1)}"
mkdir -p shots
pages=("$@")
[ ${#pages[@]} -eq 0 ] && pages=($(ls *.html | grep -v '^index.html$' | sed 's/\.html$//'))
for p in "${pages[@]}"; do
  size="1280,1700"
  case "$p" in home|compute) size="1440,1300" ;; files) size="1280,900" ;; esac
  for t in light dark; do
    "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files \
      --force-prefers-reduced-motion --window-size="$size" --virtual-time-budget=1500 \
      --screenshot="shots/$p-${STYLE:-v0}-$t${SHOT_SUFFIX:-}.png" "file://$PWD/$p.html?theme=$t&style=${STYLE:-v0}" >/dev/null 2>&1
  done
  echo "shots/$p-{light,dark}.png"
done
