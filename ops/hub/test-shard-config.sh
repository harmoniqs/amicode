#!/usr/bin/env bash
# test-shard-config.sh — the shard-derivation gate for amicode-server.sh and
# rss-watchdog.sh (amicode #1717 phase 1). Exercises the --print-shard-env seam
# across the case matrix; asserts ports, per-shard disambiguation, and that the
# legacy (no index) behavior is unchanged. Never starts a server.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
FAILS=0

check() { # check <desc> <want> <got>
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1 — want [$2] got [$3]"
    FAILS=$((FAILS + 1))
  fi
}

# --- syntax -------------------------------------------------------------------
bash -n "$HERE/amicode-server.sh" && echo "ok   amicode-server.sh syntax" || FAILS=$((FAILS + 1))
bash -n "$HERE/fleet-watchdog/rss-watchdog.sh" && echo "ok   rss-watchdog.sh syntax" || FAILS=$((FAILS + 1))

# --- amicode-server.sh: shard 2/3 derivation, explicit-env override, guards ---
g() { env -u AMICODE_SERVER_PORT -u AMICODE_ENGINE_PORT -u AMICODE_ENGINE_INSPECT "$HERE/amicode-server.sh" --print-shard-env "$@"; }

S2="$(AMICODE_SHARD_INDEX=2 g)"
check "shard2 service_port"  "service_port=4195" "$(echo "$S2" | grep '^service_port=')"
check "shard2 engine_port"   "engine_port=4194"  "$(echo "$S2" | grep '^engine_port=')"
check "shard2 inspect"       "inspect=127.0.0.1:9230" "$(echo "$S2" | grep '^inspect=')"

S3="$(AMICODE_SHARD_INDEX=3 g)"
check "shard3 service_port"  "service_port=4295" "$(echo "$S3" | grep '^service_port=')"
check "shard3 engine_port"   "engine_port=4294"  "$(echo "$S3" | grep '^engine_port=')"
check "shard3 inspect"       "inspect=127.0.0.1:9231" "$(echo "$S3" | grep '^inspect=')"

SO="$(AMICODE_SERVER_PORT=5555 AMICODE_ENGINE_PORT=5554 AMICODE_ENGINE_INSPECT=127.0.0.1:5529 AMICODE_SHARD_INDEX=2 "$HERE/amicode-server.sh" --print-shard-env)"
check "explicit env wins"    "service_port=5555" "$(echo "$SO" | grep '^service_port=')"
check "explicit engine env"  "engine_port=5554"  "$(echo "$SO" | grep '^engine_port=')"
check "explicit inspect env" "inspect=127.0.0.1:5529" "$(echo "$SO" | grep '^inspect=')"

LEGACY="$(g)"
check "legacy no index" "shard_index=none" "$(echo "$LEGACY" | grep '^shard_index=')"

if AMICODE_SHARD_INDEX=1 g >/dev/null 2>&1; then
  echo "FAIL shard1 must be rejected (legacy unit owns it)"; FAILS=$((FAILS + 1))
else
  echo "ok   shard1 rejected"
fi
if AMICODE_SHARD_INDEX=2x g >/dev/null 2>&1; then
  echo "FAIL non-numeric index must be rejected"; FAILS=$((FAILS + 1))
else
  echo "ok   non-numeric index rejected"
fi

# --- rss-watchdog.sh: per-shard pattern/ports/log, legacy unchanged ------------
gw() { env -u WATCHDOG_SERVICE -u WATCHDOG_HEALTH_PORT -u WATCHDOG_PATTERN "$HERE/fleet-watchdog/rss-watchdog.sh" --print-shard-env "$@"; }

W2="$(AMICODE_SHARD_INDEX=2 gw)"
check "wd shard2 service"    "service=co.harmoniqs.amicode-server@2.service" "$(echo "$W2" | grep '^service=')"
check "wd shard2 health"     "health_port=4194"  "$(echo "$W2" | grep '^health_port=')"
check "wd shard2 pattern"   "pattern=$HOME/.amico/server/bin/opencode serve --port 4194" "$(echo "$W2" | grep '^pattern=')"
check "wd shard2 log"        "log=$HOME/.amico/server/fleet-watchdog/rss-trajectory-shard2.log" "$(echo "$W2" | grep '^log=')"
check "wd shard2 inspect"   "inspect_port=9230" "$(echo "$W2" | grep '^inspect_port=')"

W3="$(AMICODE_SHARD_INDEX=3 gw)"
check "wd shard3 pattern"    "pattern=$HOME/.amico/server/bin/opencode serve --port 4294" "$(echo "$W3" | grep '^pattern=')"
check "wd shard3 inspect"   "inspect_port=9231" "$(echo "$W3" | grep '^inspect_port=')"

WL="$(gw)"
check "wd legacy service"   "service=co.harmoniqs.amicode-server.service" "$(echo "$WL" | grep '^service=')"
check "wd legacy health"    "health_port=4094"  "$(echo "$WL" | grep '^health_port=')"
check "wd legacy pattern"   "pattern=$HOME/.amico/server/bin/opencode serve" "$(echo "$WL" | grep '^pattern=')"
check "wd legacy log"        "log=$HOME/.amico/server/fleet-watchdog/rss-trajectory.log" "$(echo "$WL" | grep '^log=')"
check "wd legacy inspect"   "inspect_port=9229" "$(echo "$WL" | grep '^inspect_port=')"

# --- verdict -------------------------------------------------------------------
if [ "$FAILS" -gt 0 ]; then
  echo "test-shard-config: $FAILS FAILURES"; exit 1
fi
echo "test-shard-config: ALL PASS"
