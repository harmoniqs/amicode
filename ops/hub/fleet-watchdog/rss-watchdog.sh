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
# Every sample is logged — the trajectory file doubles as the #775 dataset.
set -u

THRESHOLD_KB="${WATCHDOG_THRESHOLD_KB:-2621440}"   # 1.5 GB — mid-burn, well above the ~400-700 MB healthy baseline
SERVICE="${WATCHDOG_SERVICE:-co.harmoniqs.amicode-server.service}"
PATTERN="${WATCHDOG_PATTERN:-$HOME/.amico/server/bin/opencode serve}"
HEALTH_PORT="${WATCHDOG_HEALTH_PORT:-4094}"
HEALTH_TIMEOUT="${WATCHDOG_HEALTH_TIMEOUT:-10}"
# 2026-10-05: the corroboration probe must be CHEAP. /session is the heaviest
# route on the 5.4GB DB — under legitimate 8-parallel-session load it can take
# >10s while the engine is ALIVE and working, and the probe then helped kill a
# healthy-but-saturated engine (the 04:45-05:20 "wedge" series). The engine's
# liveness is measured by its cheapest substantive route: a cached
# per-directory config. Heavy routes measure load, not life.
HEALTH_PATH="${WATCHDOG_HEALTH_PATH:-/config?directory=%2Fhome%2Faaron%2Fharmoniqs%2Fopencode}"
LOG_DIR="${WATCHDOG_LOG_DIR:-$HOME/.amico/server/fleet-watchdog}"
LOG="$LOG_DIR/rss-trajectory.log"
STAMP="$(date '+%Y-%m-%dT%H:%M:%S')"

# --- shard derivation (amicode #1717 phase 1) ---------------------------------
# One watchdog instance per engine shard (rss-watchdog@<i>, AMICODE_SHARD_INDEX
# from the unit). With multiple engines the PATTERN MUST disambiguate by the
# shard's engine port — the engine cmdline is "<bin> serve --port <p>" (SPACE
# separator, verified by ps on the live hub 2026-10-05); binary-path-only
# matching + `head -1` would grab an arbitrary shard's engine. If the pattern
# ever stops matching, this script reports server-missing and exits 0 (no
# restart authority lost silently) — the per-shard smoke asserts the match.
# No index = legacy shard-1 behavior, byte-for-byte.
# --print-shard-env: print the derived config and exit (test seam).
INSPECT_PORT=9229
if [ -n "${AMICODE_SHARD_INDEX:-}" ]; then
  OFF=$((100 * (AMICODE_SHARD_INDEX - 1)))
  SERVICE="${WATCHDOG_SERVICE:-co.harmoniqs.amicode-server@${AMICODE_SHARD_INDEX}.service}"
  HEALTH_PORT="${WATCHDOG_HEALTH_PORT:-$((4094 + OFF))}"
  PATTERN="${WATCHDOG_PATTERN:-$HOME/.amico/server/bin/opencode serve --port $((4094 + OFF))}"
  LOG="$LOG_DIR/rss-trajectory-shard${AMICODE_SHARD_INDEX}.log"
  INSPECT_PORT=$((9229 + AMICODE_SHARD_INDEX - 1))
fi
if [ "${1:-}" = "--print-shard-env" ]; then
  echo "shard_index=${AMICODE_SHARD_INDEX:-none}"
  echo "service=$SERVICE"
  echo "health_port=$HEALTH_PORT"
  echo "pattern=$PATTERN"
  echo "log=$LOG"
  echo "inspect_port=$INSPECT_PORT"
  exit 0
fi

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

# 2026-10-04 storm fix (incidents/20261003-wedge follow-up): the wedge is
# "TCP accepts, HTTP silent" -- RSS alone is NOT it. A healthy engine under
# active session load rides 2.3-2.9GB routinely; the single-sample threshold
# restart-stormed the hub 4x today (05:05/05:15/08:20/10:00), killing in-flight
# sessions mid-run. RSS over threshold now triggers the HTTP corroboration
# probe FIRST: restart only when /session does not answer. A serving engine
# is never restarted, whatever its RSS.
serving() {
  curl -sS -o /dev/null -m "$HEALTH_TIMEOUT" "http://127.0.0.1:${HEALTH_PORT}${HEALTH_PATH}" >/dev/null 2>&1
}

# 2026-10-04 #775 diagnostics: the wedge is recurring under active session load
# (three corroborated wedges today). Before the restart destroys the evidence,
# capture what the wedged engine was doing: thread states, wchan, smaps_rollup
# (heap vs mapped vs sqlite cache), log position, and a gdb all-threads
# backtrace when ptrace permits (yama scope 1 blocks non-child attach — the
# attempt is bounded and harmless when refused).
capture() {
  local tag="$1" pid="$2"
  local d="$LOG_DIR/wedge-$(date '+%Y%m%d-%H%M%S')-$tag"
  mkdir -p "$d" || return 0
  echo "$(date '+%Y-%m-%dT%H:%M:%S') watch=$tag" > "$d/stamp.txt"
  ps -eLo pid,tid,stat,pcpu,rss,wchan:32,comm --no-headers | awk -v p="$pid" '$1==p' > "$d/threads.txt" 2>/dev/null || true
  cat "/proc/$pid/status" > "$d/proc-status.txt" 2>/dev/null || true
  cat "/proc/$pid/smaps_rollup" > "$d/smaps_rollup.txt" 2>/dev/null || true
  cat "/proc/$pid/smaps" > "$d/smaps.txt" 2>/dev/null || true
  cat "/proc/$pid/io" > "$d/proc-io.txt" 2>/dev/null || true
  lsof -nP -p "$pid" > "$d/lsof.txt" 2>/dev/null || true
  timeout 60 gdb -p "$pid" -batch -ex "set pagination off" -ex "thread apply all bt 15" > "$d/gdb-threads.txt" 2>&1 || echo "gdb attach refused (ptrace_scope)" >> "$d/gdb-threads.txt"
  timeout 40 "$HOME/opt/node22/bin/node" "$LOG_DIR/cdp-stack.mjs" "$INSPECT_PORT" "$d/cdp-stack.json" > "$d/cdp-stack-stdout.txt" 2>&1 || echo "cdp capture failed" >> "$d/cdp-stack-stdout.txt"
  tail -200 "$HOME/.local/share/opencode/log/opencode.log" > "$d/opencode-log-tail.txt" 2>/dev/null || true
  sha256sum "$HOME/.amico/server/bin/opencode" > "$d/opencode.sha256" 2>/dev/null || true
  echo "$d"
}
if [ "$rss_kb" -ge "$THRESHOLD_KB" ]; then
  if serving; then
    echo "$STAMP pid=$pid rss_kb=$rss_kb status=rss-high-but-serving (no restart)" >> "$LOG"
    capture "prewedge" "$pid" >/dev/null 2>&1 || true
    exit 0
  fi
  capture "wedge" "$pid" >/dev/null 2>&1 || true
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
