#!/usr/bin/env bash
# hub-restart.sh — the ONE restart-safe path for the canonical Amicode hub.
# Runs ON THE HUB. The extension's "Amicode: Restart Hub Server" command drives
# it over SSH; agents on the hub may call it directly. NOBODY should inline
# `systemctl stop`/`restart` for the hub from an agent shell: a session hosted
# ON the hub kills its own runtime mid-command (the 2026-08-30 double incident)
# — the only safe inline form is a scheduled `systemd-run --user`.
#
# Modes:
#   restart           single-verb restart + verify (the default)
#   verify            unit active + HTTP answered + binary version, one line
#   stage <binary>    stage a new server binary (sha-verified copy, no touch of
#                     the running one)
#   swap              atomic rename staged → live + sidecar refresh. NO service
#                     stop: rename(2) over a running executable is legal and
#                     atomic; the new image loads at the next restart.
#
# Safety laws (the 2026-08-30 incident contract):
#   - A bare `systemctl stop` appears NOWHERE in any path. Restart is always a
#     single verb; an explicit stop would override Restart=always.
#   - The swap is rename-based: if anything dies mid-swap the old binary is
#     either still running or already replaced — never half-written.
#   - trap/finally: on ANY exit, if the unit is inactive the script starts it.
#     The hub is never left down by this script.
set -uo pipefail

BIN_DIR="$HOME/.amico/server/bin"
BIN="$BIN_DIR/opencode"
STAGED="$BIN_DIR/.opencode.staging"
SIDECAR="$BIN_DIR/opencode.sha256"
UNIT="co.harmoniqs.amicode-server.service"
PORT="${AMICODE_SERVER_PORT:-4096}"

# The unit answers with 200 (unsecured) or 401 (auth gate) when serving; both
# are healthy — the canary is "the socket answers", not the auth posture.
serving_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/" 2>/dev/null; }

verify() {
  local state code ver
  state="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
  code="$(serving_code)"
  ver="$("$BIN" --version 2>/dev/null | head -1 || true)"
  echo "verify: unit=${state:-unknown} http=${code:-none} version=${ver:-unknown}"
  [ "$state" = "active" ] && { [ "$code" = "200" ] || [ "$code" = "401" ]; }
}

ensure_up() {
  # The one unconditional recovery: never leave the hub down on any exit path.
  if ! systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
    echo "hub-restart: unit inactive at exit — starting it"
    systemctl --user start "$UNIT" 2>/dev/null || true
  fi
}
trap ensure_up EXIT

mode="${1:-restart}"
case "$mode" in
  restart)
    systemctl --user restart "$UNIT"
    sleep 2
    if verify; then exit 0; fi
    sleep 3
    if verify; then exit 0; fi
    echo "FAIL: hub not healthy after restart (see journalctl --user -u $UNIT)"
    exit 1
    ;;
  verify)
    if verify; then exit 0; fi
    exit 1
    ;;
  stage)
    src="${2:?usage: hub-restart.sh stage <binary>}"
    if [ ! -x "$src" ]; then echo "FAIL: $src is not executable"; exit 1; fi
    install -m 0755 "$src" "$STAGED"
    a="$(sha256sum "$src" | awk '{print $1}')"
    b="$(sha256sum "$STAGED" | awk '{print $1}')"
    if [ "$a" != "$b" ]; then echo "FAIL: staged sha mismatch"; exit 1; fi
    echo "OK staged $(basename "$src") sha=${b:0:16}… (swap to activate)"
    ;;
  swap)
    if [ ! -f "$STAGED" ]; then echo "FAIL: nothing staged at $STAGED"; exit 1; fi
    mv -f "$STAGED" "$BIN"
    chmod 0755 "$BIN"
    sha256sum "$BIN" | awk '{print $1}' > "$SIDECAR"
    echo "OK swapped sha=$(cut -c1-16 "$SIDECAR")… — restart to load it"
    ;;
  *)
    echo "usage: hub-restart.sh [restart|verify|stage <binary>|swap]"
    exit 2
    ;;
esac
