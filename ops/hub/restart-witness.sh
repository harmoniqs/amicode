#!/usr/bin/env bash
# restart-witness.sh — the independent witness for the restart guard (amicode#2044).
#
# The guard's own decision log can only say what the guard saw; a guard that is
# blind (wrong cgroup, missing script, a path that never calls it) would make the
# safety count read zero. The witness looks at the OTHER side: for every unit
# start, which run directories look killed by it — run.log present, no FINISHED
# marker, run.log last written within the 60 s before the start — and was a guard
# decision on record for that restart?
#
#   guarded    an `allow`/`override`/`force` decision for that unit within the 120 s
#              before the start (the guard let it through; "via" says which)
#   unguarded  no such decision — the restart bypassed (or was blind to) the guard
#
# Output: one JSON line per suspected loss, then exactly
#   guarded_losses=N unguarded_losses=M
#
# Inputs (env):
#   SOLVE_WITNESS_STARTS  file of `unit iso-timestamp` lines (tests / offline);
#                         else the unit starts come from `journalctl --user -u <unit>
#                         -o short-iso` "Started" lines for SOLVE_WITNESS_UNITS
#                         (default: the three hub engine units) since
#                         SOLVE_WITNESS_SINCE (default "7 days ago")
#   AMICO_RUNS_ROOT      run dirs live at $AMICO_RUNS_ROOT/*/r*/ (default ~/.amico/runs)
#   SOLVE_GUARD_LOG      the decision log (default ~/.amico/server/restart-decisions.log)
# Read-only: it never touches a unit, a run dir, or the log.
set -u

RUNS="${AMICO_RUNS_ROOT:-$HOME/.amico/runs}"
LOG="${SOLVE_GUARD_LOG:-$HOME/.amico/server/restart-decisions.log}"
UNITS="${SOLVE_WITNESS_UNITS:-co.harmoniqs.amicode-server.service co.harmoniqs.amicode-server@2.service co.harmoniqs.amicode-server@3.service}"
SINCE="${SOLVE_WITNESS_SINCE:-7 days ago}"
LOSS_WINDOW=60
GUARD_WINDOW=120

# --- unit starts: "unit epoch" ------------------------------------------------
starts=()
if [ -n "${SOLVE_WITNESS_STARTS:-}" ]; then
  while read -r unit iso; do
    [ -n "$unit" ] || continue
    epoch="$(date -d "$iso" +%s 2>/dev/null)" || continue
    starts+=("$unit $epoch")
  done < "$SOLVE_WITNESS_STARTS"
else
  for unit in $UNITS; do
    while read -r iso rest; do
      case "$rest" in *" Started "*|*"]: Started "*) ;; *) continue ;; esac
      epoch="$(date -d "$iso" +%s 2>/dev/null)" || continue
      starts+=("$unit $epoch")
    done < <(journalctl --user -u "$unit" -o short-iso --no-pager --since "$SINCE" 2>/dev/null)
  done
fi

# --- decisions that let a restart through: "unit epoch decision" -------------
allowed=()
if [ -f "$LOG" ]; then
  re_ts='"ts" *: *"([^"]*)"'; re_unit='"unit" *: *"([^"]*)"'; re_dec='"decision" *: *"(allow|override|force)"'
  while IFS= read -r line; do
    [[ "$line" =~ $re_dec ]] || continue
    dec="${BASH_REMATCH[1]}"
    [[ "$line" =~ $re_ts ]] || continue
    ts="${BASH_REMATCH[1]}"
    [[ "$line" =~ $re_unit ]] || continue
    unit="${BASH_REMATCH[1]}"
    epoch="$(date -d "$ts" +%s 2>/dev/null)" || continue
    allowed+=("$unit $epoch $dec")
  done < "$LOG"
fi

guarded=0
unguarded=0
shopt -s nullglob
for entry in "${starts[@]+"${starts[@]}"}"; do
  unit="${entry% *}"
  start="${entry#* }"
  via=""
  for a in "${allowed[@]+"${allowed[@]}"}"; do
    read -r au ae ad <<< "$a"
    if [ "$au" = "$unit" ] && [ "$ae" -le "$start" ] && [ $(( start - ae )) -le "$GUARD_WINDOW" ]; then via="$ad"; fi
  done
  for dir in "$RUNS"/*/r*/; do
    dir="${dir%/}"
    [ -f "$dir/run.log" ] || continue
    [ -e "$dir/FINISHED" ] && continue
    mtime="$(stat -c %Y "$dir/run.log" 2>/dev/null)" || continue
    [ "$mtime" -le "$start" ] && [ $(( start - mtime )) -le "$LOSS_WINDOW" ] || continue
    if [ -n "$via" ]; then class=guarded; guarded=$((guarded + 1)); else class=unguarded; unguarded=$((unguarded + 1)); fi
    printf '{"unit":"%s","unit_start":"%s","run_dir":"%s","run_log_mtime":"%s","classification":"%s","via":"%s"}\n' \
      "$unit" "$(date -u -d "@$start" +%Y-%m-%dT%H:%M:%SZ)" "$dir" "$(date -u -d "@$mtime" +%Y-%m-%dT%H:%M:%SZ)" "$class" "$via"
  done
done
echo "guarded_losses=$guarded unguarded_losses=$unguarded"
