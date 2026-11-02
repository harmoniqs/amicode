#!/usr/bin/env bash
# lane-roll.sh — roll shards 2/3 onto the swapped engine binary the moment each
# goes idle (no busy sessions), never interrupting a running turn. One-shot per
# shard; exits when both have rolled (or after 48h). Log: ~/.amico/server/lane-roll.log
#
# Committed from the hub's hand-maintained copy (amicode#2044 / A0; it lived only
# on the hub until now). The ONLY behavioural change: the restart goes through
# solve-guard.sh. "No busy sessions" is not "no compute" — a solve started from a
# plain bash command lives in the shard's process group and a restart kills it.
# A blocked shard is logged as `deferred`, NOT marked done, and retried next tick.
#
# Test seams (all default to the production values):
#   LANE_ROLL_LOG, LANE_ROLL_DONE_DIR (/tmp), LANE_ROLL_IDLE_GAP (20s between the two
#   idle reads), LANE_ROLL_TICK (60s), LANE_ROLL_SETTLE (15s after a restart),
#   LANE_ROLL_DEADLINE_S (172800), SOLVE_GUARD_SCRIPT.
set -u
LOG="${LANE_ROLL_LOG:-$HOME/.amico/server/lane-roll.log}"
DONE_DIR="${LANE_ROLL_DONE_DIR:-/tmp}"
GUARD="${SOLVE_GUARD_SCRIPT:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/solve-guard.sh}"
WANT="$(cat "$HOME/.amico/server/bin/opencode.CANONICAL-sha")"
D=%2Fhome%2Faaron%2Fharmoniqs%2Fopencode
declare -A PORT=([2]=4194 [3]=4294)
deadline=$(( $(date +%s) + ${LANE_ROLL_DEADLINE_S:-172800} ))
done_all() { for s in 2 3; do [ -f "$DONE_DIR/lane-roll-$s.done" ] || return 1; done; return 0; }
while ! done_all && [ "$(date +%s)" -lt "$deadline" ]; do
  for s in 2 3; do
    [ -f "$DONE_DIR/lane-roll-$s.done" ] && continue
    p=${PORT[$s]}
    pid=$(pgrep -f "opencode serve --port $p" | head -1)
    if [ -n "$pid" ] && [ "$(sha256sum /proc/$pid/exe 2>/dev/null | cut -d" " -f1)" = "$WANT" ]; then
      echo "$(date +%F_%T) shard $s already on ${WANT:0:16}" >> "$LOG"; touch "$DONE_DIR/lane-roll-$s.done"; continue
    fi
    st=$(curl -sS -m 8 "http://127.0.0.1:$p/session/status?directory=$D" 2>/dev/null)
    # require two consecutive idle reads 20s apart (no between-turn flicker)
    if [ "$st" = "{}" ]; then
      sleep "${LANE_ROLL_IDLE_GAP:-20}"
      st2=$(curl -sS -m 8 "http://127.0.0.1:$p/session/status?directory=$D" 2>/dev/null)
      if [ "$st2" = "{}" ]; then
        unit="co.harmoniqs.amicode-server@$s.service"
        echo "$(date +%F_%T) shard $s idle — restarting onto ${WANT:0:16}" >> "$LOG"
        bash "$GUARD" run "$unit" lane-roll --defer -- systemctl --user restart "$unit" >> "$LOG" 2>&1
        rc=$?
        if [ "$rc" -ne 0 ]; then
          if [ "$rc" -eq 3 ]; then
            echo "$(date +%F_%T) shard $s deferred — live compute in its process group; retrying next tick" >> "$LOG"
          else
            echo "$(date +%F_%T) shard $s restart failed (rc=$rc); retrying next tick" >> "$LOG"
          fi
          continue   # NOT marked done: try again next tick
        fi
        sleep "${LANE_ROLL_SETTLE:-15}"
        npid=$(pgrep -f "opencode serve --port $p" | head -1)
        echo "$(date +%F_%T) shard $s now $(sha256sum /proc/$npid/exe 2>/dev/null | cut -c1-16) unit=$(systemctl --user is-active "$unit")" >> "$LOG"
        touch "$DONE_DIR/lane-roll-$s.done"
      fi
    fi
  done
  sleep "${LANE_ROLL_TICK:-60}"
done
echo "$(date +%F_%T) lane-roll exiting" >> "$LOG"
