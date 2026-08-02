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

# Shape A (current, since opencode ead3274d3 "lock down appearance settings;
# force v2 layout"): settings.tsx sets `newLayoutDesigns: createMemo(() => true)`
# — unconditional, no channel dependency. Minifies to `newLayoutDesigns:<F>(()=>!0)`.
# `if`, not `grep && { ... }`: under `set -e` a non-matching grep in an AND-list
# aborts the script with no message, which reads as a silent failure.
if grep -aq 'newLayoutDesigns:[A-Za-z$_]\{1,8\}(()=>!0)' "$BIN"; then
  echo "OK: amicode UI gate hardcoded ON (unconditional memo) — $BIN"
  exit 0
fi
if grep -aq 'newLayoutDesigns:[A-Za-z$_]\{1,8\}(()=>!1)' "$BIN"; then
  echo "FAIL: amicode UI gate unconditional memo is OFF (=>!1) — $BIN"
  exit 1
fi

# Shape C (1.18.10 merge): the memo survived but the property went SHORTHAND —
# `newLayoutDesigns:<VAR>` with `<VAR>=[wrapper](()=>!0)` at the assignment site
# (the wrapper call is optional — it minifies differently per target). Mirrors
# the fork's amicode-release.yml gate; `\$` in the double-quoted classes because
# `$_A` is a valid shell name and `set -u` would abort on expansion.
VAR=$( { grep -aoh 'newLayoutDesigns:[$_A-Za-z0-9]\{1,20\}[,}]' "$BIN" || true; } | head -1 | sed 's/newLayoutDesigns://; s/[,}]//')
if test -n "$VAR"; then
  if grep -aq "[^A-Za-z0-9_\$]${VAR}=[\$_A-Za-z]\{0,8\}(()=>!1)" "$BIN"; then
    echo "FAIL: amicode UI gate shorthand memo is OFF (=>!1) — $BIN was built with OPENCODE_CHANNEL=latest/prod and hides every amicode surface"
    exit 1
  fi
  if grep -aq "[^A-Za-z0-9_\$]${VAR}=[\$_A-Za-z]\{0,8\}(()=>!0)" "$BIN"; then
    echo "OK: amicode UI gate hardcoded ON (shorthand memo ${VAR}=…(()=>!0)) — $BIN"
    exit 0
  fi
  echo "FAIL: shorthand memo var ${VAR} found but its assignment matches neither (()=>!0) nor (()=>!1) in $BIN (minifier drift?)"
  exit 1
fi

# Shape B (legacy, channel-gated): `...general?.newLayoutDesigns,<VAR>)` where the
# default lands in <VAR> as `<VAR>=!0` (on) / `<VAR>=!1` (off). Kept so this check
# still works if the setting is ever rewired back to the channel default.
# `|| true`: under `set -o pipefail` a no-match grep would abort here, so the
# "pattern not found" diagnostic below could never fire.
VAR=$( { grep -aoh 'newLayoutDesigns,[A-Za-z$_]\{1,8\})' "$BIN" || true; } | head -1 | sed 's/newLayoutDesigns,//; s/)//')
test -n "$VAR" || { echo "FAIL: gate pattern not found in $BIN (minifier drift? update this check)"; exit 1; }

if grep -aq "[^A-Za-z0-9_\$]${VAR}=!0" "$BIN"; then
  echo "OK: amicode UI gate ON (${VAR}=!0) — $BIN"
else
  echo "FAIL: amicode UI gate OFF (${VAR}=!1) — $BIN was built with OPENCODE_CHANNEL=latest/prod and hides every amicode surface"
  exit 1
fi
