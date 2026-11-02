#!/usr/bin/env bash
# solve-guard.sh — the restart guard: no hub engine unit is restarted while
# compute is running in its process group (amicode#2044 / A0).
#
# WHY: solves live in the engine's process group and the units kill the whole
# group on restart, so every restart path can destroy a running scientific
# solve. This is the one shared check every restart path we control calls.
#
# CGROUP-FIRST: compute is detected by what is actually in the unit's cgroup
# tree (cgroup.procs of the unit's ControlGroup and every descendant), NOT by
# run directories — an agent that starts `julia` from a plain bash command has
# no run dir and no run.lock, and a run-dir guard would be blind to it.
#
# PROTECTED PROCESS (any process in the unit's cgroup tree that is):
#   (a) comm == julia, any age, unless its cmdline matches
#       $SOLVE_GUARD_IGNORE_REGEX (default 'LanguageServer|SymbolServer'); or
#   (b) older than $SOLVE_GUARD_MIN_AGE seconds (default 300), whose comm is NOT
#       in the infrastructure set (bash zsh sh dash node bun opencode sleep tail
#       cat grep curl timeout systemd-run, plus $SOLVE_GUARD_INFRA_EXTRA) and
#       which is not the unit's MainPID. `timeout` wraps a child; the child is
#       judged on its own.
#
# EXEMPT PROCESS (amicode#2087): a julia process is NOT protected iff it is
# provably an abandoned precompile worker — ALL FOUR must hold, any one failing
# keeps it protected exactly as above:
#   1. its argv has the precompile output flag `--output-o` as a whole argument
#      (or `--output-o=...`; `--output-ox` etc. do not count);
#   2. it is sleeping (state S or I) — a running (R) or uninterruptible (D)
#      process is real work;
#   3. its parent pid is neither in the unit's cgroup tree nor the unit's
#      MainPID (the launcher died and it was reparented outside the unit);
#   4. its age is >= $SOLVE_GUARD_ORPHAN_PRECOMPILE_AGE seconds (default 1800).
# SOLVE_GUARD_ORPHAN_PRECOMPILE=0 disables the exemption entirely (default on).
# Every exemption is printed by `check` (`solve-guard: exempt <pid> julia <age>s
# orphaned-precompile <cmd>`) and recorded in the decision log's "exempt" array,
# so the guard never silently ignores a process. The guard NEVER signals or
# kills anything; it only decides.
#
# USAGE
#   solve-guard.sh check <unit>
#       exit 0 clear / exit 3 blocked (pid comm etimes cmdline on stderr).
#       Read-only: no lock, no decision-log line.
#   solve-guard.sh run <unit> <caller> [--defer] -- <cmd...>
#       Under ONE exclusive per-unit flock ($SOLVE_GUARD_LOCK_DIR/<unit>.lock):
#       check, sleep $SOLVE_GUARD_RECHECK_DELAY (default 2), check again, then
#       run <cmd...> (the restart) while STILL holding the lock. Blocked => the
#       command is not run, exit 3. --defer = the caller will retry on its own
#       schedule (watchdog, lane-roll): the blocked decision is logged as
#       `deferred` instead of `refused`.
#       Override: a file $SOLVE_GUARD_OVERRIDE_DIR/<unit> allows the restart,
#       is logged as `override`, and is deleted (single use).
#       SOLVE_GUARD_FORCE=1 allows the restart, logged as `force`.
#       An unreadable cgroup tree FAILS CLOSED (blocked), never reads as clear.
#   solve-guard.sh log <unit> <caller> <decision> [reason]
#       append one decision line (the watchdog uses it for `alert`).
#
# DECISION LOG ($SOLVE_GUARD_LOG, default ~/.amico/server/restart-decisions.log),
# one JSON line per decision:
#   {"ts","caller","unit","decision":allow|refused|deferred|override|force|alert,
#    "protected":[{"pid","comm","etimes","cmd"}],
#    "exempt"?:[{"pid","comm","etimes","cmd","reason"}], "reason"?}
#   ("exempt" is omitted when empty; `protected` is unchanged.)
#
# RESIDUAL WINDOW (accepted, documented): between the second check and the
# restart itself compute can still be started — the guard narrows the window to
# the recheck-to-exec gap, it cannot close it. Slice A closes it: `amico run`
# will take this same per-unit lock. Also OUT of scope (accepted risk until
# slice A): Restart=always respawn after a crash, OOM kills, reboots, and a
# human's manual `systemctl restart`.
#
# Test seams (env): SOLVE_GUARD_CGROUP_ROOT (/sys/fs/cgroup), SOLVE_GUARD_CGROUP_PATH
# (skip the `systemctl show` lookup), SOLVE_GUARD_MAIN_PID, SOLVE_GUARD_PROC_ROOT
# (/proc), SOLVE_GUARD_LOCK_DIR, SOLVE_GUARD_LOG, SOLVE_GUARD_OVERRIDE_DIR,
# SOLVE_GUARD_RECHECK_DELAY, SOLVE_GUARD_MIN_AGE, SOLVE_GUARD_LOCK_TIMEOUT (120),
# SOLVE_GUARD_ORPHAN_PRECOMPILE (1), SOLVE_GUARD_ORPHAN_PRECOMPILE_AGE (1800).
# This file may also be sourced (functions only; no side effects).
set -u

SG_PROT=()      # protected processes found by the last scan: "pid<TAB>comm<TAB>etimes<TAB>cmd"
SG_EXEMPT=()    # exempted orphan precompile workers: "pid<TAB>comm<TAB>etimes<TAB>cmd<TAB>reason"
SG_REASON=""    # why a scan was indeterminate (empty on a clean scan)
SG_DIR=""

sg_log_path() { printf '%s' "${SOLVE_GUARD_LOG:-$HOME/.amico/server/restart-decisions.log}"; }

# Resolve the unit's cgroup directory into SG_DIR. rc 0 = found, 2 = the unit has
# no cgroup (inactive: nothing to protect), 1 = indeterminate (fail closed).
sg_cgroup_dir() {
  local unit=$1 root cg
  root="${SOLVE_GUARD_CGROUP_ROOT:-/sys/fs/cgroup}"
  SG_DIR=""
  if [ ! -d "$root" ]; then SG_REASON="cgroup root $root not readable"; return 1; fi
  if [ -n "${SOLVE_GUARD_CGROUP_PATH+x}" ]; then
    cg="$SOLVE_GUARD_CGROUP_PATH"
  else
    if ! cg="$(systemctl --user show -p ControlGroup --value "$unit" 2>/dev/null)"; then
      SG_REASON="systemctl show ControlGroup failed for $unit"; return 1
    fi
  fi
  cg="${cg#/}"
  [ -n "$cg" ] || return 2
  [ -d "$root/$cg" ] || return 2
  SG_DIR="$root/$cg"
}

sg_main_pid() {
  if [ -n "${SOLVE_GUARD_MAIN_PID+x}" ]; then printf '%s' "$SOLVE_GUARD_MAIN_PID"; return; fi
  systemctl --user show -p MainPID --value "$1" 2>/dev/null || printf '0'
}

# Scan <unit>'s cgroup tree into SG_PROT. rc 0 = scan ok (SG_PROT may be empty),
# 1 = indeterminate.
sg_scan() {
  local unit=$1 rc proc main fields infra min_age ignore clk up f pid comm stat rest state start etimes cmd
  local orphan_on orphan_age ppid arg has_flag
  local -A unit_pids=()
  local -a argv
  SG_PROT=(); SG_EXEMPT=(); SG_REASON=""
  sg_cgroup_dir "$unit"; rc=$?
  [ "$rc" -eq 2 ] && return 0
  [ "$rc" -eq 0 ] || return 1

  proc="${SOLVE_GUARD_PROC_ROOT:-/proc}"
  main="$(sg_main_pid "$unit")"
  min_age="${SOLVE_GUARD_MIN_AGE:-300}"
  ignore="${SOLVE_GUARD_IGNORE_REGEX:-LanguageServer|SymbolServer}"
  infra=" bash zsh sh dash node bun opencode sleep tail cat grep curl timeout systemd-run ${SOLVE_GUARD_INFRA_EXTRA:-} "
  clk="$(getconf CLK_TCK 2>/dev/null || echo 100)"
  orphan_on="${SOLVE_GUARD_ORPHAN_PRECOMPILE:-1}"
  orphan_age="${SOLVE_GUARD_ORPHAN_PRECOMPILE_AGE:-1800}"
  read -r up _ < "$proc/uptime" || { SG_REASON="cannot read $proc/uptime"; return 1; }

  # the unit's whole pid set first: the orphan test needs to know whether a
  # process's parent is inside the unit
  while IFS= read -r -d '' f; do
    while IFS= read -r pid; do
      [ -n "$pid" ] && unit_pids[$pid]=1
    done < "$f"
  done < <(find "$SG_DIR" -type f -name cgroup.procs -print0 2>/dev/null)

  while IFS= read -r -d '' f; do
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      comm="$(cat "$proc/$pid/comm" 2>/dev/null)" || continue   # exited since it was listed
      stat="$(cat "$proc/$pid/stat" 2>/dev/null)" || continue
      rest="${stat##*) }"                                       # comm may contain spaces/parens
      read -ra fields <<< "$rest"
      state="${fields[0]:-}"
      ppid="${fields[1]:-0}"
      [ "$state" = "Z" ] && continue                            # zombie: holds no compute
      start="${fields[19]:-0}"
      etimes="$(awk -v u="$up" -v s="$start" -v c="$clk" 'BEGIN { printf "%d", u - s / c }')"
      has_flag=0
      if [ "$comm" = "julia" ] && [ "$orphan_on" != "0" ]; then
        # whole-argument match on the NUL-separated argv, before any truncation
        mapfile -d '' -t argv < "$proc/$pid/cmdline" 2>/dev/null || argv=()
        for arg in "${argv[@]+"${argv[@]}"}"; do
          case "$arg" in --output-o|--output-o=*) has_flag=1; break ;; esac
        done
      fi
      cmd="$(tr '\0' ' ' < "$proc/$pid/cmdline" 2>/dev/null)"
      cmd="${cmd% }"
      [ -n "$cmd" ] || cmd="[$comm]"
      cmd="${cmd:0:200}"

      if [ "$comm" = "julia" ]; then
        [[ "$cmd" =~ $ignore ]] && continue
        if [ "$has_flag" = 1 ] && { [ "$state" = "S" ] || [ "$state" = "I" ]; } \
          && [ "$etimes" -ge "$orphan_age" ] && [ "$ppid" != "$main" ] \
          && [ -z "${unit_pids[$ppid]+x}" ]; then
          SG_EXEMPT+=("$pid"$'\t'"$comm"$'\t'"$etimes"$'\t'"$cmd"$'\t'"orphaned-precompile")
          continue
        fi
      else
        [ "$etimes" -ge "$min_age" ] || continue
        case "$infra" in *" $comm "*) continue ;; esac
        [ "$pid" = "$main" ] && continue
      fi
      SG_PROT+=("$pid"$'\t'"$comm"$'\t'"$etimes"$'\t'"$cmd")
    done < "$f"
  done < <(find "$SG_DIR" -type f -name cgroup.procs -print0 2>/dev/null)
  return 0
}

sg_json_str() {
  local s=$1
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\t'/ }"
  printf '"%s"' "$(printf '%s' "$s" | tr -d '\000-\037')"
}

# sg_log <decision> <caller> <unit> [reason] — one JSON line from the last scan.
sg_log() {
  local decision=$1 caller=$2 unit=$3 reason=${4:-} line prot="" exempt="" row pid comm et cmd why log
  for row in "${SG_PROT[@]+"${SG_PROT[@]}"}"; do
    IFS=$'\t' read -r pid comm et cmd <<< "$row"
    prot+="${prot:+,}{\"pid\":$pid,\"comm\":$(sg_json_str "$comm"),\"etimes\":$et,\"cmd\":$(sg_json_str "$cmd")}"
  done
  for row in "${SG_EXEMPT[@]+"${SG_EXEMPT[@]}"}"; do
    IFS=$'\t' read -r pid comm et cmd why <<< "$row"
    exempt+="${exempt:+,}{\"pid\":$pid,\"comm\":$(sg_json_str "$comm"),\"etimes\":$et,\"cmd\":$(sg_json_str "$cmd"),\"reason\":$(sg_json_str "$why")}"
  done
  line="{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"caller\":$(sg_json_str "$caller"),\"unit\":$(sg_json_str "$unit"),\"decision\":\"$decision\",\"protected\":[$prot]"
  [ -n "$exempt" ] && line+=",\"exempt\":[$exempt]"
  [ -n "$reason" ] && line+=",\"reason\":$(sg_json_str "$reason")"
  line+="}"
  log="$(sg_log_path)"
  mkdir -p "$(dirname "$log")" 2>/dev/null
  printf '%s\n' "$line" >> "$log"
}

sg_report_exempt() { # what the scan deliberately did not count, on stderr
  local row pid comm et cmd why
  for row in "${SG_EXEMPT[@]+"${SG_EXEMPT[@]}"}"; do
    IFS=$'\t' read -r pid comm et cmd why <<< "$row"
    echo "solve-guard: exempt $pid $comm ${et}s $why $cmd" >&2
  done
}

sg_report() { # human-readable list of what is blocking, on stderr
  local row pid comm et cmd
  if [ -n "$SG_REASON" ]; then echo "solve-guard: BLOCKED — $SG_REASON (failing closed)" >&2; fi
  for row in "${SG_PROT[@]+"${SG_PROT[@]}"}"; do
    IFS=$'\t' read -r pid comm et cmd <<< "$row"
    echo "solve-guard: protected $pid $comm ${et}s $cmd" >&2
  done
  sg_report_exempt
}

# 0 = clear, 1 = blocked (compute present, or the scan was indeterminate)
sg_blocked() { # <unit>
  sg_scan "$1" || return 0
  [ "${#SG_PROT[@]}" -gt 0 ] && return 0
  return 1
}

sg_cmd_check() {
  [ $# -ge 1 ] || { echo "usage: solve-guard.sh check <unit>" >&2; return 2; }
  if sg_blocked "$1"; then
    echo "solve-guard: $1 has live compute in its process group — restart refused" >&2
    sg_report
    return 3
  fi
  sg_report_exempt
  return 0
}

sg_cmd_run() {
  [ $# -ge 2 ] || { echo "usage: solve-guard.sh run <unit> <caller> [--defer] -- <cmd...>" >&2; return 2; }
  local unit=$1 caller=$2 blocked_decision=refused rc lockdir override
  shift 2
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    case "$1" in
      --defer) blocked_decision=deferred ;;
      *) echo "solve-guard: unknown option $1" >&2; return 2 ;;
    esac
    shift
  done
  [ "${1:-}" = "--" ] || { echo "solve-guard: missing '-- <cmd...>'" >&2; return 2; }
  shift
  [ $# -ge 1 ] || { echo "solve-guard: empty command" >&2; return 2; }

  lockdir="${SOLVE_GUARD_LOCK_DIR:-$HOME/.amico/server/restart-locks}"
  mkdir -p "$lockdir" 2>/dev/null
  exec 9> "$lockdir/$unit.lock"
  if ! flock -w "${SOLVE_GUARD_LOCK_TIMEOUT:-120}" 9; then
    SG_PROT=(); SG_EXEMPT=()
    sg_log "$blocked_decision" "$caller" "$unit" "lock-timeout"
    echo "solve-guard: could not take the restart lock for $unit — refused" >&2
    return 3
  fi

  override="${SOLVE_GUARD_OVERRIDE_DIR:-$HOME/.amico/server/restart-override}/$unit"
  if [ -f "$override" ]; then
    sg_scan "$unit" || true
    rm -f "$override"
    sg_log override "$caller" "$unit"
    echo "solve-guard: override for $unit consumed — restarting" >&2
  elif [ "${SOLVE_GUARD_FORCE:-}" = "1" ]; then
    sg_scan "$unit" || true
    sg_log force "$caller" "$unit"
    echo "solve-guard: FORCE — restarting $unit regardless of live compute" >&2
  else
    # check, wait, check again — all under the lock, immediately before the restart
    if sg_blocked "$unit"; then
      sg_log "$blocked_decision" "$caller" "$unit" "$SG_REASON"
      echo "solve-guard: $unit has live compute in its process group — restart $blocked_decision" >&2
      sg_report
      return 3
    fi
    sleep "${SOLVE_GUARD_RECHECK_DELAY:-2}"
    if sg_blocked "$unit"; then
      sg_log "$blocked_decision" "$caller" "$unit" "$SG_REASON"
      echo "solve-guard: compute appeared in $unit during the recheck delay — restart $blocked_decision" >&2
      sg_report
      return 3
    fi
    sg_log allow "$caller" "$unit"
  fi

  # the command runs while we still hold the lock; it must not inherit the lock fd
  "$@" 9>&-
  rc=$?
  return "$rc"
}

sg_cmd_log() {
  [ $# -ge 3 ] || { echo "usage: solve-guard.sh log <unit> <caller> <decision> [reason]" >&2; return 2; }
  sg_scan "$1" || true
  sg_log "$3" "$2" "$1" "${4:-}"
}

sg_main() {
  local verb=${1:-}
  [ $# -gt 0 ] && shift
  case "$verb" in
    check) sg_cmd_check "$@" ;;
    run) sg_cmd_run "$@" ;;
    log) sg_cmd_log "$@" ;;
    *) echo "usage: solve-guard.sh check <unit> | run <unit> <caller> [--defer] -- <cmd...> | log <unit> <caller> <decision> [reason]" >&2; return 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  sg_main "$@"
  exit $?
fi
