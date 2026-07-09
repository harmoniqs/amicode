#!/usr/bin/env bash
# Assert a vendored opencode binary ships the amicode UI ON.
#
# WHY: every amicode surface (home cards, v2 titlebar, draft flow) is gated at
# RUNTIME on settings.general.newLayoutDesigns, whose default is
#   newLayoutDesignsDefault = VITE_OPENCODE_CHANNEL !== "prod"   (opencode app/src/context/settings.tsx)
# A binary built with OPENCODE_CHANNEL=latest → channel "prod" → gate defaults
# OFF → the features are compiled in but INVISIBLE. Building with
# OPENCODE_CHANNEL=dev flips the default ON. This check greps the minified
# bundle embedded in the binary for the gate's default and fails closed if it is
# off, so a feature-dead binary can never ride green through CI or a release.
#
# Usage: assert_ui_gate.sh <path-to-opencode-binary>
set -euo pipefail

BIN="${1:?usage: assert_ui_gate.sh <path-to-opencode-binary>}"
test -f "$BIN" || { echo "FAIL: no binary at $BIN"; exit 1; }

# Minified shape: `...general?.newLayoutDesigns,<VAR>)` where the default lands in
# <VAR> as `<VAR>=!0` (on) / `<VAR>=!1` (off).
VAR=$(grep -aoh 'newLayoutDesigns,[A-Za-z$_]\{1,8\})' "$BIN" | head -1 | sed 's/newLayoutDesigns,//; s/)//')
test -n "$VAR" || { echo "FAIL: gate pattern not found in $BIN (minifier drift? update this check)"; exit 1; }

if grep -aq "[^A-Za-z0-9_\$]${VAR}=!0" "$BIN"; then
  echo "OK: amicode UI gate ON (${VAR}=!0) — $BIN"
else
  echo "FAIL: amicode UI gate OFF (${VAR}=!1) — $BIN was built with OPENCODE_CHANNEL=latest/prod and hides every amicode surface"
  exit 1
fi
