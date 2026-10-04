#!/usr/bin/env bash
# Fleet watchdog — RSS-trajectory guard for the canonical opencode server.
# Born from the 2026-09-03/04 wedge series (#775): the server's RSS climbs into
# a TCP-accepts-HTTP-silent wedge; a 5-min check with restart authority breaks
# the self-sustaining trap (polling clients feed the leak on a wedged server).
#
# 2026-10-04 fix (incidents/20261003-wedge): the original default pattern
# "opencode serve --port=4095" matched nothing since the M3 cutover (#955) —
# the engine moved to 4094, AND the engine cmdline is "--port 4094" (space),
# so the pattern's "--port=4095" (equals) could never match on any port.
# Match by binary path instead: immune to port moves and separator style.
#
# 2026-10-04 storm fix (same incident, hours later): a single RSS sample is
# NOT the wedge. A healthy engine under active session load rides 2.3-2.9 GB
# routinely; the single-sample threshold restart-stormed the hub 4x in one
# morning (05:05/05:15/08:20/10:00), killing in-flight sessions mid-run.
# The wedge is "TCP accepts, HTTP silent" — RSS over threshold now triggers
# the HTTP corroboration probe FIRST: restart only when /session does not
# answer. A serving engine is never restarted, whatever its RSS.
#
# Every sample is logged — the trajectory file doubles as the #775 dataset.
set -u

THRESHOLD_KB="${WATCHDOG_THRESHOLD_KB:-1536000}"   # 1.5 GB — corroboration-gated, no longer restart-authoritative alone
SERVICE="${WATCHDOG_SERVICE:-co.harmoniqs.amicode-server.service}"
PATTERN="${WATCHDOG_PATTERN:-$HOME/.amico/server/bin/opencode serve}"
HEALTH_PORT="${WATCHDOG_HEALTH_PORT:-4094}"
HEALTH_TIMEOUT="${WATCHDOG_HEALTH_TIMEOUT:-10}"
LOG_DIR="${WATCHDOG_LOG_DIR:-$HOME/.amico/server/fleet-watchdog}"
LOG="$LOG_DIR/rss-trajectory.log"
STAMP="$(date '+%Y-%m-%dT%H:%M:%S')"

mkdir -p "$LOG_DIR"

pid="$(pgrep -f "$PATTERN" | head -1)"
if [ -z "$pid" ]; then
  echo "$STAMP pid=none status=server-missing" >> "$LOG"
  exit 0   # not the watchdog's job to start it; systemd Restart= handles crashes
fi

rss_kb="$(ps -o rss= --no-headers -p "$pid" | tr -d ' ')"
if [ -z "$rss_kb" ]; then
  echo "$STAMP pid=$pid status=rss-unreadable" >> "$LOG"
  exit 0
fi

serving() {
  curl -sS -o /dev/null -m "$HEALTH_TIMEOUT" "http://127.0.0.1:${HEALTH_PORT}/session" >/dev/null 2>&1
}

if [ "$rss_kb" -ge "$THRESHOLD_KB" ]; then
  if serving; then
    echo "$STAMP pid=$pid rss_kb=$rss_kb status=rss-high-but-serving (no restart)" >> "$LOG"
    exit 0
  fi
fi

echo "$STAMP pid=$pid rss_kb=$rss_kb threshold_kb=$THRESHOLD_KB" >> "$LOG"

if [ "$rss_kb" -ge "$THRESHOLD_KB" ]; then
  echo "$STAMP action=restart reason=rss-over-threshold-and-http-silent rss_kb=$rss_kb" >> "$LOG"
  systemctl --user restart "$SERVICE"
  sleep 5
  new_pid="$(pgrep -f "$PATTERN" | head -1)"
  new_rss="$(ps -o rss= --no-headers -p "$new_pid" 2>/dev/null | tr -d ' ')"
  echo "$STAMP action=restart-done old_pid=$pid new_pid=${new_pid:-none} new_rss_kb=${new_rss:-unknown}" >> "$LOG"
fi
