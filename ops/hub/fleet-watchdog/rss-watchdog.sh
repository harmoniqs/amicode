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
# 2026-11-01 (amicode#2044 / A0): the THREE diverged copies of this script are
# reconciled into this one. It restores the 2026-10-07 liveness-alone wedge
# recovery (two consecutive silent probes => capture + restart regardless of
# RSS, per-shard marker) that the Oct 11 deploy of an older file silently
# regressed, keeps the gateway-secret-aware probe, and derives the engine
# pattern from the shard port in EVERY mode (the legacy no-index pattern was
# binary-path-only, which with three engines running matches an arbitrary
# shard's engine). EVERY restart goes through solve-guard.sh: a restart is
# refused (deferred) while compute is running in the unit's process group; after
# WATCHDOG_DEFER_ALERT_TICKS deferrals an alert marker is raised and the
# watchdog KEEPS deferring; a human override file allows the restart.
#
# Every sample is logged — the trajectory file doubles as the #775 dataset.
set -u

THRESHOLD_KB="${WATCHDOG_THRESHOLD_KB:-2621440}"   # 1.5 GB — mid-burn, well above the ~400-700 MB healthy baseline
SERVICE="${WATCHDOG_SERVICE:-co.harmoniqs.amicode-server.service}"
PATTERN="${WATCHDOG_PATTERN:-$HOME/.amico/server/bin/opencode serve --port 4094}"
HEALTH_PORT="${WATCHDOG_HEALTH_PORT:-4094}"
HEALTH_TIMEOUT="${WATCHDOG_HEALTH_TIMEOUT:-10}"
# 2026-10-05: the corroboration probe must be CHEAP. /session is the heaviest
# route on the 5.4GB DB — under legitimate 8-parallel-session load it can take
# >10s while the engine is ALIVE and working, and the probe then helped kill a
# healthy-but-saturated engine (the 04:45-05:20 "wedge" series). The engine's
# liveness is measured by its cheapest substantive route: a cached
# per-directory config. Heavy routes measure load, not life.
HEALTH_PATH="${WATCHDOG_HEALTH_PATH:-/config?directory=%2Fhome%2Faaron%2Fharmoniqs%2Fopencode}"
# amicode #1760 P1: once armed, the engine requires the gateway stamp on its
# API routes — the probe must carry it or it measures the auth gate, not the
# engine (and a wedged-but-authed engine would look dead). Read fresh per
# probe: arming/disarming needs no watchdog restart.
GW_SECRET_FILE="${WATCHDOG_SECRET_FILE:-$HOME/.amico/server/engine-gateway-secret.env}"
LOG_DIR="${WATCHDOG_LOG_DIR:-$HOME/.amico/server/fleet-watchdog}"
LOG="$LOG_DIR/rss-trajectory.log"
# restart guard (solve-guard.sh sits one directory above this script, in both the
# repo — ops/hub/ — and the deploy — ~/.amico/server/). Missing guard = no restart.
GUARD="${SOLVE_GUARD_SCRIPT:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../solve-guard.sh}"
DEFER_ALERT_TICKS="${WATCHDOG_DEFER_ALERT_TICKS:-12}"
ALERT_DIR="${WATCHDOG_ALERT_DIR:-$HOME/.amico/server/alerts}"
POST_RESTART_SLEEP="${WATCHDOG_POST_RESTART_SLEEP:-5}"
STAMP="$(date '+%Y-%m-%dT%H:%M:%S')"

# --- shard derivation (amicode #1717 phase 1) ---------------------------------
# One watchdog instance per engine shard (rss-watchdog@<i>, AMICODE_SHARD_INDEX
# from the unit). With multiple engines the PATTERN MUST disambiguate by the
# shard's engine port — the engine cmdline is "<bin> serve --port <p>" (SPACE
# separator, verified by ps on the live hub 2026-10-05); binary-path-only
# matching + `head -1` would grab an arbitrary shard's engine. If the pattern
# ever stops matching, this script reports server-missing and exits 0 (no
# restart authority lost silently) — the per-shard smoke asserts the match.
# No index = the legacy shard-1 unit; its default pattern is now port-specific
# too (--port 4094) — see the 2026-11-01 note in the header.
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
  if [ -s "$GW_SECRET_FILE" ]; then
    echo "gateway_secret=armed"
  else
    echo "gateway_secret=absent"
  fi
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
  local gw=()
  if [ -s "$GW_SECRET_FILE" ]; then
    gw=(-H "X-Amicode-Gateway-Secret: $(cut -d= -f2- "$GW_SECRET_FILE")")
  fi
  curl -sS -o /dev/null -m "$HEALTH_TIMEOUT" "${gw[@]}" \
    "http://127.0.0.1:${HEALTH_PORT}${HEALTH_PATH}" >/dev/null 2>&1
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
# Per-shard marker (2026-10-07: a SHARED marker was a cross-shard kill race —
# the healthy shards' watchdog instances wiped the wedged shard's marker on
# their serving ticks, so the wedged shard armed forever and never fired).
SILENT_MARKER="$LOG_DIR/http-silent-tick${AMICODE_SHARD_INDEX:+-shard$AMICODE_SHARD_INDEX}"
DEFER_FILE="$LOG_DIR/defer-count-$SERVICE"
ALERT_FILE="$ALERT_DIR/live-compute-deferred-$SERVICE"

# guarded_restart <reason> <capture-tag> — the ONLY place this script restarts the engine.
# Returns 0 when the restart ran, 1 when it was deferred or failed (the caller
# keeps its armed state and retries next tick). Never exits non-zero: a deferral
# is a normal decision, not a failed unit.
guarded_restart() {
  local reason="$1" tag="$2" rc=0 n
  # forensics once per deferral episode — not every 5 minutes while compute runs
  [ -f "$DEFER_FILE" ] || capture "$tag" "$pid" >/dev/null 2>&1 || true
  if [ ! -f "$GUARD" ]; then
    echo "$STAMP action=restart-deferred reason=$reason status=guard-missing ($GUARD) — never restarting unguarded" >> "$LOG"
    rc=3
  else
    echo "$STAMP action=restart reason=$reason rss_kb=$rss_kb" >> "$LOG"
    bash "$GUARD" run "$SERVICE" rss-watchdog --defer -- systemctl --user restart "$SERVICE" >> "$LOG" 2>&1 || rc=$?
  fi
  if [ "$rc" -eq 3 ]; then
    n=$(( $(cat "$DEFER_FILE" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$DEFER_FILE"
    echo "$STAMP action=restart-deferred reason=$reason deferrals=$n (live compute in $SERVICE's process group)" >> "$LOG"
    if [ "$n" -ge "$DEFER_ALERT_TICKS" ]; then
      mkdir -p "$ALERT_DIR"
      echo "$STAMP $SERVICE needs a restart ($reason) but live compute has blocked it for $n ticks. To force it: touch ${SOLVE_GUARD_OVERRIDE_DIR:-$HOME/.amico/server/restart-override}/$SERVICE" > "$ALERT_FILE"
      # one decision-log ALERT line when the bound is first crossed, then every bound-multiple
      if [ $(( n % DEFER_ALERT_TICKS )) -eq 0 ]; then
        bash "$GUARD" log "$SERVICE" rss-watchdog alert "deferred $n ticks: $reason" >/dev/null 2>&1 || true
      fi
    fi
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    echo "$STAMP action=restart-failed reason=$reason rc=$rc" >> "$LOG"
    return 1
  fi
  rm -f "$DEFER_FILE" "$ALERT_FILE"
  sleep "$POST_RESTART_SLEEP"
  new_pid="$(pgrep -f "$PATTERN" | head -1)"
  new_rss="$(ps -o rss= --no-headers -p "$new_pid" 2>/dev/null | tr -d ' ')"
  echo "$STAMP action=restart-done old_pid=$pid new_pid=${new_pid:-none} new_rss_kb=${new_rss:-unknown}" >> "$LOG"
  return 0
}

if [ "$rss_kb" -ge "$THRESHOLD_KB" ]; then
  if serving; then
    echo "$STAMP pid=$pid rss_kb=$rss_kb status=rss-high-but-serving (no restart)" >> "$LOG"
    capture "prewedge" "$pid" >/dev/null 2>&1 || true
    rm -f "$SILENT_MARKER" "$DEFER_FILE" "$ALERT_FILE" 2>/dev/null || true
    exit 0
  fi
fi

echo "$STAMP pid=$pid rss_kb=$rss_kb threshold_kb=$THRESHOLD_KB" >> "$LOG"

# Branch 1 — memory wedge: RSS over threshold AND the HTTP surface silent.
if [ "$rss_kb" -ge "$THRESHOLD_KB" ]; then
  guarded_restart "rss-over-threshold-and-http-silent" "wedge" && rm -f "$SILENT_MARKER"
  exit 0
fi

# Branch 2 — 2026-10-07: the #775-class wedge is not always a memory wedge — the
# 2026-10-07 07:55 event wedged at 401MB with the main thread parked in a
# timed futex and the HTTP surface silent. The RSS gate alone would have
# left that engine dead forever. Liveness is sufficient on its own: TWO
# consecutive silent probes capture forensics and restart the engine
# regardless of RSS. A single silent tick only arms the marker (one blip
# must not kill in-flight sessions). A deferral KEEPS the marker armed, so the
# next silent tick retries; a healthy tick disarms it.
if ! serving; then
  if [ -f "$SILENT_MARKER" ]; then
    if guarded_restart "http-silent-two-ticks" "http-silent"; then
      rm -f "$SILENT_MARKER"
    fi
    exit 0
  fi
  touch "$SILENT_MARKER"
  echo "$STAMP pid=$pid rss_kb=$rss_kb status=http-silent-first-tick (armed)" >> "$LOG"
  exit 0
fi
rm -f "$SILENT_MARKER" "$DEFER_FILE" "$ALERT_FILE" 2>/dev/null || true
