#!/usr/bin/env bash
# client-log-freshness.sh — #1745: is the panel's client telemetry ALIVE?
#
# Sep 23 → Oct 10: client-errors.log was silent for six weeks and nothing
# noticed — every panel-side debugging round depended on Aaron's eyes instead
# of server-side logs. This is the mechanical freshness check that closes
# that gap: the age of the newest "heartbeat": line in the log, loudly
# reported, so staleness like Sep 23 → Oct 10 can never recur unnoticed.
#
# Verdicts (exit code is the machine answer; the text is the loud part):
#   exit 0  FRESH             a panel heartbeated within --stale-after
#   exit 1  STALE             newest heartbeat is older than --stale-after
#   exit 1  NO-HEARTBEAT      the log has captures but no heartbeat ever
#                              (a pre-#1745 panel build or a dead ingest)
#   exit 1  LOG-MISSING        the ingest target does not exist
#
# This is an ops-run check (deploy ritual, on demand) — a STALE verdict when
# nobody has a panel open is a REPORT, not an alarm. The always-on silence
# alarm is the frontdoor's heartbeat canary (HEARTBEAT-ALARM lines in
# frontdoor.log), which only fires while panel streams are actually live.
#
# Usage:
#   client-log-freshness.sh [--stale-after SECONDS] [--log PATH]
#   client-log-freshness.sh --self-test      fixtures only, no production paths
#
# Env: AMICODE_CLIENT_LOG (the frontdoor ingest target; --log wins)
#      AMICODE_CLIENT_LOG_STALE_AFTER (default 900s — 15min; a panel open
#      anywhere on the fleet heartbeats every ~60s, so fresh means < ~90s,
#      and 900s tolerates a check run while a panel is mid-reconnect)
set -uo pipefail

STALE_AFTER="${AMICODE_CLIENT_LOG_STALE_AFTER:-900}"
LOG="${AMICODE_CLIENT_LOG:-$HOME/.amico/server/client-errors.log}"
SELF_TEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --stale-after) STALE_AFTER="${2:?}"; shift 2 ;;
    --log) LOG="${2:?}"; shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    *) echo "usage: client-log-freshness.sh [--stale-after N] [--log PATH] [--self-test]" >&2; exit 2 ;;
  esac
done

# --- the check -----------------------------------------------------------------
# The heartbeat is {"heartbeat": <epoch ms>} (the panel's #1745 liveness
# canary). Newest wins: a stale line only means silence since then.
check() {
  if [ ! -f "$LOG" ]; then
    echo "STALE: LOG-MISSING — $LOG does not exist (the ingest has never run here)"
    return 1
  fi
  local line ts beat_s age
  line="$(grep '"heartbeat":' "$LOG" 2>/dev/null | tail -1 || true)"
  if [ -z "$line" ]; then
    echo "STALE: NO-HEARTBEAT — $LOG has no heartbeat line (pre-#1745 panel build, or the ingest route is dead)"
    return 1
  fi
  ts="$(printf '%s' "$line" | sed -n 's/.*"heartbeat":\([0-9]\{10,\}\).*/\1/p')"
  if [ -z "$ts" ]; then
    echo "STALE: NO-HEARTBEAT — heartbeat line present but no parseable timestamp: $line"
    return 1
  fi
  beat_s=$((ts / 1000))
  age=$(($(date +%s) - beat_s))
  if [ "$age" -le "$STALE_AFTER" ]; then
    echo "FRESH: last panel heartbeat ${age}s ago (stale-after ${STALE_AFTER}s) — $LOG"
    return 0
  fi
  echo "STALE: last panel heartbeat ${age}s ago (> stale-after ${STALE_AFTER}s) — $LOG; check HEARTBEAT-ALARM in frontdoor.log"
  return 1
}

# --- self-test: fixtures only, no production paths ------------------------------
self_test() {
  local dir fails=0
  dir="$(mktemp -d "${TMPDIR:-/tmp}/client-log-freshness-XXXXXX")"
  trap 'rm -rf "$dir"' RETURN

  local now_ms now_s
  now_ms="$(date +%s%3N)"
  now_s=$((now_ms / 1000))

  printf 'C abc123\nsome capture\n{"heartbeat":%s}\n' "$now_ms" > "$dir/fresh.log"
  printf '{"heartbeat":%s}\n' "$(( (now_s - 9999) * 1000 ))" > "$dir/stale.log"
  printf 'C abc123\nsome capture, no heartbeat ever\n' > "$dir/none.log"

  local out rc
  out="$(LOG="$dir/fresh.log" check)"; rc=$?
  [ $rc -eq 0 ] && echo "$out" | grep -q "^FRESH" || { echo "FAIL fresh fixture: rc=$rc out=$out"; fails=$((fails + 1)); }
  out="$(AMICODE_CLIENT_LOG_STALE_AFTER=900 LOG="$dir/stale.log" check)"; rc=$?
  [ $rc -eq 1 ] && echo "$out" | grep -q "s ago (> stale-after" || { echo "FAIL stale fixture: rc=$rc out=$out"; fails=$((fails + 1)); }
  out="$(LOG="$dir/none.log" check)"; rc=$?
  [ $rc -eq 1 ] && echo "$out" | grep -q "NO-HEARTBEAT" || { echo "FAIL no-heartbeat fixture: rc=$rc out=$out"; fails=$((fails + 1)); }
  out="$(LOG="$dir/missing.log" check)"; rc=$?
  [ $rc -eq 1 ] && echo "$out" | grep -q "LOG-MISSING" || { echo "FAIL missing-log fixture: rc=$rc out=$out"; fails=$((fails + 1)); }

  if [ "$fails" -gt 0 ]; then echo "client-log-freshness self-test: $fails FAILURES"; return 1; fi
  echo "client-log-freshness self-test: 4/4 ok"
  return 0
}

if [ "$SELF_TEST" = "1" ]; then
  self_test
  exit $?
fi
check
