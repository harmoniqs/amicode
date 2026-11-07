#!/usr/bin/env bash
# engine-gateway-secret.sh (amicode #1760 P1) — the one-door shared secret's
# single authority.
#
# The canonical artifact is ~/.amico/server/engine-gateway-secret.env —
# a mode-600 KEY=value file:
#     AMICODE_ENGINE_SHARED_SECRET=<64-hex>
# read by, in ONE provisioning step:
#   - amicode-server.sh    — sources it at boot, so every shard's ENGINE
#                            inherits AMICODE_ENGINE_SHARED_SECRET
#   - the frontdoor unit   — EnvironmentFile= drop-in, so the frontdoor
#                            stamps the header on every engine-facing dial
#   - rss-watchdog.sh      — reads the value fresh per probe (no env plumbing,
#                            arming/disarming needs no watchdog restart)
#
# ABSENT file = compat mode: engines stay open (today's behavior) — the
# rollout safety valve AND the rollback path.
#
# Idempotent: `ensure` NEVER rotates an existing secret — rotation is a
# deliberate ops act (see GATEWAY-SECRET-RUNBOOK.md: the secret must land on
# the frontdoor AND every engine in ONE restart cycle; a half-rolled state is
# a fleet outage, and a quiet rotation recreates one).
set -euo pipefail

SERVER_DIR="${AMICO_SERVER_DIR:-$HOME/.amico/server}"
ENV_FILE="$SERVER_DIR/engine-gateway-secret.env"

case "${1:-}" in
  ensure)
    if [ -f "$ENV_FILE" ]; then
      echo "engine-gateway-secret: exists ($ENV_FILE, mode $(stat -c '%a' "$ENV_FILE"))" >&2
      exit 0
    fi
    umask 077
    mkdir -p "$SERVER_DIR"
    secret="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    tmp="$(mktemp "$SERVER_DIR/engine-gateway-secret.env.XXXXXX")"
    printf 'AMICODE_ENGINE_SHARED_SECRET=%s\n' "$secret" > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$ENV_FILE"
    echo "engine-gateway-secret: generated $ENV_FILE (mode 600)" >&2
    ;;
  print)
    if [ ! -f "$ENV_FILE" ]; then
      echo "engine-gateway-secret: $ENV_FILE absent (compat mode — engines open)" >&2
      exit 1
    fi
    cut -d= -f2- "$ENV_FILE"
    ;;
  path)
    echo "$ENV_FILE"
    ;;
  *)
    echo "usage: engine-gateway-secret.sh {ensure|print|path}" >&2
    exit 2
    ;;
esac
