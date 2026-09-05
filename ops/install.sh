#!/usr/bin/env bash
# install.sh — deploy the versioned ops scripts to ~/.amico/ops/ (the mini
# and the linux fleet hosts — the role-parity cadence runs on erlich).
# Idempotent; copies scripts ONLY (never launchd plists, never the systemd
# units, never runtime state, never the papers-digest frozen bundle — see
# ops/README.md for those and for the one-time unit installation).
# hunt.sh is additionally a FLEET-HOST deploy (erlich): copy it over — see the
# hunts section of ops/README.md.
set -euo pipefail

DEST="$HOME/.amico/ops"
SRC="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DEST/papers-digest" "$DEST/skill-freshness" "$DEST/role-parity"

install -m 0755 "$SRC/fleet-status.sh"          "$DEST/fleet-status.sh"
install -m 0755 "$SRC/fleet-alert.sh"           "$DEST/fleet-alert.sh"
install -m 0755 "$SRC/hub-restart.sh"           "$DEST/hub-restart.sh"
install -m 0755 "$SRC/hub-upgrade-smoke.sh"    "$DEST/hub-upgrade-smoke.sh"
install -m 0755 "$SRC/papers-digest/daily.sh"   "$DEST/papers-digest/daily.sh"
install -m 0755 "$SRC/hunt.sh"                  "$DEST/hunt.sh"
install -m 0755 "$SRC/skill-freshness/run-skill-freshness.sh" "$DEST/skill-freshness/run-skill-freshness.sh"
install -m 0755 "$SRC/role-parity/run-role-parity-check.sh"   "$DEST/role-parity/run-role-parity-check.sh"

echo "deployed to $DEST:"
echo "  fleet-status.sh   (launchd co.harmoniqs.fleet-status, every 5 min)"
echo "  fleet-alert.sh    (launchd co.harmoniqs.fleet-alert, every 15 min)"
echo "  papers-digest/daily.sh (launchd co.harmoniqs.amicode-papers-digest, daily ~09:00)"
echo "  skill-freshness/run-skill-freshness.sh (launchd co.harmoniqs.skill-freshness, daily ~04:30)"
echo "  role-parity/run-role-parity-check.sh (erlich: systemd co.harmoniqs.role-parity.timer, daily ~04:45 — see ops/README.md; macOS machines: the launchd plist)"
echo "  hunt.sh           (on demand — the hardened hunt wrapper; also copy to erlich, see ops/README.md)"
echo "state files, plists, systemd units, and the frozen bundle were left untouched."
echo "to activate before the next interval: launchctl kickstart -k gui/$(id -u)/<agent-label> (or on erlich: systemctl --user start co.harmoniqs.role-parity.service)"
