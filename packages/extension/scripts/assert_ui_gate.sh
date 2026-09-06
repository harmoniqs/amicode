#!/usr/bin/env bash
# Assert a vendored opencode binary is the build the #823 M3 cutover needs.
#
# HISTORY (the gate this replaces): until the M3 cutover the vendored binary
# was the FORK, whose embedded web UI was the framed chat — so this check
# grepped the minified bundle for the `newLayoutDesigns` gate being hardcoded
# ON (a fork built with OPENCODE_CHANNEL=latest compiled the features in but
# hid them). At cutover the framed app comes from the amicode service's SHELF
# (the app-bundle dist, built from the overlay), NOT the engine's embedded UI
# — the engine's own UI is only the degraded fallback when the service fails
# to boot — so "the amicode surfaces are visible in the ENGINE's UI" is no
# longer an invariant at all. What the vendored ENGINE must now guarantee:
#
#   1. it IS the pinned build — `opencode --version` equals the lock's
#      version. A stale or mis-vendored binary (the sha gate catches a
#      corrupted one at download; this re-asserts on the installed artifact)
#      fails here, fail-closed. RUNNER-ARCH ONLY: the vsix-gate loops every
#      platform's binary on one machine, and a foreign-arch binary cannot be
#      executed — for those, the version check skips honestly (the sha256
#      gate IS the cross-platform pin verification; it ran at download).
#   2. it carries the `auth_token` query-carrier machinery — the framed
#      path's bootstrap seam (#823): the panel iframe's document GET rides
#      ?auth_token=, and the app's credential-less connections (split-frame
#      panes, terminal websockets) ride it too. The stock server's
#      authorization middleware reads AUTH_TOKEN_QUERY; a binary without it
#      strands every credential-less framed consumer at a 401 wall.
#      Arch-INDEPENDENT (a byte grep), so it holds for every platform's
#      binary.
#
# Usage: assert_ui_gate.sh <path-to-opencode-binary>
set -euo pipefail

BIN="${1:?usage: assert_ui_gate.sh <path-to-opencode-binary>}"
test -f "$BIN" || { echo "FAIL: no binary at $BIN"; exit 1; }

# The lock lives beside the extension root: the binary sits at
# <extension>/vendor/opencode/<platform>/opencode → up THREE dirs from the
# binary's directory is the extension root.
LOCK="$(cd "$(dirname "$BIN")/../../.." && pwd)/opencode.lock.json"
test -f "$LOCK" || { echo "FAIL: no opencode.lock.json at $LOCK"; exit 1; }
WANT_VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$LOCK")"
test -n "$WANT_VERSION" || { echo "FAIL: lock has no version"; exit 1; }

# Same-arch binaries get the runtime version re-assertion; foreign-arch ones
# (the vsix-gate's cross-platform loop) skip it — the sha256 gate verified
# their pin at download.
BIN_PLATFORM="$(basename "$(dirname "$BIN")")"
RUNNER_PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
case "$RUNNER_PLATFORM" in
  linux-x86_64) RUNNER_PLATFORM="linux-x64" ;;
  linux-aarch64) RUNNER_PLATFORM="linux-arm64" ;;
  darwin-arm64) RUNNER_PLATFORM="darwin-arm64" ;;
  *) RUNNER_PLATFORM="" ;;
esac
if [ -n "$RUNNER_PLATFORM" ] && [ "$BIN_PLATFORM" = "$RUNNER_PLATFORM" ]; then
  GOT_VERSION="$("$BIN" --version)"
  if [ "$GOT_VERSION" != "$WANT_VERSION" ]; then
    echo "FAIL: vendored binary reports version '$GOT_VERSION' but the lock pins '$WANT_VERSION' — a stale or mis-vendored engine"
    exit 1
  fi
  echo "OK: vendored binary is the pinned build ($GOT_VERSION)"
else
  echo "OK: foreign-arch binary ($BIN_PLATFORM on $RUNNER_PLATFORM) — version re-assert skipped (the sha256 download gate holds the pin); the carrier grep below still applies"
fi

# The #823 bootstrap seam's engine side: the ?auth_token= carrier the framed
# path authenticates credential-less GETs with (fork AND stock middleware
# both name AUTH_TOKEN_QUERY = "auth_token"). `if`, not a bare grep: under
# `set -e` a non-matching grep in an AND-list aborts silently.
if grep -aq "auth_token" "$BIN"; then
  echo "OK: engine carries the ?auth_token= carrier (the #823 framed bootstrap seam)"
else
  echo "FAIL: no auth_token carrier machinery in $BIN — every credential-less framed consumer would 401"
  exit 1
fi
