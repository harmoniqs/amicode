#!/usr/bin/env bash
# install.sh — deploy the versioned ops scripts to ~/.amico/ops/ on the mini.
# Idempotent; copies scripts ONLY (never launchd plists, never runtime state,
# never the papers-digest frozen bundle — see ops/README.md for those).
set -euo pipefail

DEST="$HOME/.amico/ops"
SRC="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DEST/papers-digest"

install -m 0755 "$SRC/fleet-status.sh"          "$DEST/fleet-status.sh"
install -m 0755 "$SRC/fleet-alert.sh"           "$DEST/fleet-alert.sh"
install -m 0755 "$SRC/papers-digest/daily.sh"   "$DEST/papers-digest/daily.sh"

echo "deployed to $DEST:"
echo "  fleet-status.sh   (launchd co.harmoniqs.fleet-status, every 5 min)"
echo "  fleet-alert.sh    (launchd co.harmoniqs.fleet-alert, every 15 min)"
echo "  papers-digest/daily.sh (launchd co.harmoniqs.amicode-papers-digest, daily ~09:00)"
echo "state files, plists, and the frozen bundle were left untouched."
echo "to activate before the next interval: launchctl kickstart -k gui/$(id -u)/<agent-label>"
