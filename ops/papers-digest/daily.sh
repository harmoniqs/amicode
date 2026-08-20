#!/bin/bash
# papers-digest daily — the intelligent arXiv digest to #papers (#412).
# Runs the FROZEN bundle (never the repo checkout — branches move); upgrade =
# copy a new dist/amico.js over bin/ + refresh the sidecar (the server pattern).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
BIN="$HOME/.amico/ops/papers-digest/bin/amico.js"
LOG="$HOME/.amico/ops/papers-digest/log.txt"
echo "[$(date -u +%FT%TZ)] digest run" >> "$LOG"
node "$BIN" papers digest --feed quant-ph --top 5 --post papers >> "$LOG" 2>&1 || echo "[$(date -u +%FT%TZ)] digest FAILED (see above)" >> "$LOG"
