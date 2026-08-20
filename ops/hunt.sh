#!/usr/bin/env bash
# hunt.sh — the hardened hunt wrapper (harmoniqs/amicode#426).
#
# Retires the raw-nohup dispatch pattern:
#   ssh <host> 'cd ~/qldpc-challenge && nohup ~/.local/bin/uv run python -u \
#       research/candidates/<hunt>.py > /tmp/<hunt>.log 2>&1 &'
# Every clause of that line was a failure mode: no timeout (a wedged hunt hangs
# invisibly forever), no heartbeat (a silent wrapper is indistinguishable from a
# dead one), logs in /tmp (lost on reboot), status by ps-grep (nothing adopts an
# orphan). This wrapper replaces the whole line:
#
#   bounded     the command runs under `timeout -k <kill-after> <timeout>` — on
#               hosts without GNU timeout (macOS) an equivalent TERM-then-KILL
#               babysitter runs instead (the fleet-status.sh killer pattern).
#   heartbeats  a heartbeat file under the hunt dir is touched every
#               --heartbeat seconds while the wrapper lives; mtime is liveness.
#   durable     everything lands under ~/.amico/ops/hunts/<id>/ (ops-adjacent,
#               synced-adjacent — never /tmp), stdout+stderr in hunt.log.
#   tracked     a FLEET RECORD is created at launch (state running, pid = this
#               wrapper, host = local) and finished by the wrapper itself
#               (settled on exit 0, crashed on nonzero/timeout/signal). If the
#               wrapper is killed -9 or the host dies, the record stays running
#               with a dead pid and `amico fleet sweep` on that host adopts it —
#               the registry's designed orphan path. Status is `amico fleet
#               list`, never ps-grep.
#
# The fleet registry root follows the CLI's own precedence ($AMICO_FLEET_DIR,
# else ~/.amico/ops/fleet) — set it on hosts that keep the registry elsewhere.

set -euo pipefail

ID=""
TIMEOUT="6h"
KILL_AFTER="60s"
HEARTBEAT="30"
AMICO="${AMICO_BIN:-amico}"
HUNTS="${AMICO_HUNTS_DIR:-$HOME/.amico/ops/hunts}"
BG=0
ATTACHED=0
CMD=()

usage() {
  cat <<'EOF'
usage: hunt.sh --id <id> [flags] -- <command...>

  --id           hunt id; also the session id (hunt-<id>) and the dir name.
                 Re-running a taken id uniquifies (-2, -3, ...): one session per
                 run, never a clobbered record.
  --timeout      bound for the command (90s, 30m, 6h). Default 6h — a hunt may
                 run long, never forever.
  --kill-after   grace after TERM before KILL. Default 60s.
  --heartbeat    heartbeat touch interval, seconds. Default 30.
  --amico        the amico CLI (default $AMICO_BIN, else `amico` on PATH).
  --hunts-dir    default ~/.amico/ops/hunts.
  --bg           detach: re-exec under nohup and return immediately (the
                 detached child still launches and finishes the record).

Everything lands under <hunts-dir>/<id>/: hunt.log (wrapper notes + the
command's stdout/stderr) and heartbeat (mtime = liveness). The fleet record is
hunt-<id> in the amico fleet registry: launch at start, settled/crashed at end,
`amico fleet sweep` adopts the record if this wrapper dies first.
EOF
  exit "${1:-0}"
}

die() { echo "hunt.sh: $*" >&2; exit 64; }

while [ $# -gt 0 ]; do
  case "$1" in
    --id)          ID="${2:-}"; shift 2 ;;
    --timeout)     TIMEOUT="${2:-}"; shift 2 ;;
    --kill-after)  KILL_AFTER="${2:-}"; shift 2 ;;
    --heartbeat)   HEARTBEAT="${2:-}"; shift 2 ;;
    --amico)       AMICO="${2:-}"; shift 2 ;;
    --hunts-dir)   HUNTS="${2:-}"; shift 2 ;;
    --bg)          BG=1; shift ;;
    --__attached)  ATTACHED=1; shift ;;   # internal: set by the --bg re-exec
    --help|-h)     usage 0 ;;
    --)            shift; break ;;
    *)             echo "hunt.sh: unknown flag $1" >&2; usage 64 ;;
  esac
done
[ $# -gt 0 ] || die "no command given after --"
CMD=("$@")

# --id must be a safe filename stem (mirrors the registry's session-id rule).
case "$ID" in
  ''|*[!A-Za-z0-9._-]*) die "--id '${ID}' must match [A-Za-z0-9][A-Za-z0-9._-]* (it names the session record and the hunt dir)" ;;
  .*|*..*) die "--id must start with a letter or digit and contain no '..'" ;;
esac

# Durations: digits with an optional fractional part and one s/m/h/d suffix.
valid_duration() { [[ "$1" =~ ^[0-9]+([.][0-9]+)?[smhd]?$ ]]; }
valid_duration "$TIMEOUT"    || die "--timeout '${TIMEOUT}' is not a duration (90s, 30m, 6h)"
valid_duration "$KILL_AFTER" || die "--kill-after '${KILL_AFTER}' is not a duration (90s, 30m, 6h)"
[[ "$HEARTBEAT" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "--heartbeat '${HEARTBEAT}' is not a number of seconds"

# Whole seconds for the babysitter's sleeps (floored at 1; validated above).
dur_seconds() {
  local v="$1" suffix=""
  case "$v" in
    *[smhd]) suffix="${v: -1}"; v="${v%?}" ;;
  esac
  v="${v%.*}"
  [ -z "$v" ] || [ "$v" = "0" ] && v=1
  case "$suffix" in
    m) echo $(( v * 60 )) ;;
    h) echo $(( v * 3600 )) ;;
    d) echo $(( v * 86400 )) ;;
    *) echo "$v" ;;
  esac
}

# One session per run: a taken id uniquifies rather than clobbering (the record
# for a previous run of the same hunt is history — keep it).
if [ "$ATTACHED" -ne 1 ]; then
  ORIG="$ID"; N=2
  while [ -e "$HUNTS/$ID" ]; do
    ID="${ORIG}-${N}"; N=$((N + 1))
  done
fi
DIR="$HUNTS/$ID"
SESSION="hunt-$ID"
LOG="$DIR/hunt.log"
HB="$DIR/heartbeat"

# --bg: hand the RESOLVED id to a detached child and return. The child re-runs
# this script with --__attached (no re-uniquify — the dir is ours now) and owns
# the whole lifecycle: launch, heartbeat, bound, finish.
if [ "$BG" -eq 1 ] && [ "$ATTACHED" -ne 1 ]; then
  mkdir -p "$DIR"
  nohup bash "$0" \
    --id "$ID" --__attached \
    --timeout "$TIMEOUT" --kill-after "$KILL_AFTER" --heartbeat "$HEARTBEAT" \
    --amico "$AMICO" --hunts-dir "$HUNTS" \
    -- "${CMD[@]}" >>"$LOG" 2>&1 &
  echo "hunt $SESSION detached (pid $!) — log: $LOG ; status: amico fleet status --session $SESSION"
  exit 0
fi

mkdir -p "$DIR"
{
  printf '[wrapper] %s host=%s session=%s pid=%s timeout=%s kill-after=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)" "$SESSION" "$$" "$TIMEOUT" "$KILL_AFTER"
  printf '[wrapper] command:'
  for a in "${CMD[@]}"; do printf ' %q' "$a"; done
  printf '\n'
} >>"$LOG"

command -v "$AMICO" >/dev/null 2>&1 \
  || die "amico CLI not found ($AMICO) — set --amico or \$AMICO_BIN; without the CLI there is no record, and an untracked hunt is the bug this wrapper exists to fix"

# ── the record: launch (created once, held by THIS pid) ───────────────────────
if ! "$AMICO" fleet launch --session "$SESSION" --pid "$$" >>"$LOG" 2>&1; then
  echo "hunt.sh: fleet launch refused — hunt NOT started (see $LOG)" >&2
  exit 64
fi

# ── heartbeat: mtime is liveness ──────────────────────────────────────────────
# The helper subshells (heartbeat, and the babysitter below) redirect to
# /dev/null on PURPOSE: they must not hold the command's output pipes, or every
# caller that waits on our stdout (ssh, spawnSync) blocks on an orphaned sleep
# long after the hunt itself is done.
touch "$HB"
( while kill -0 "$$" 2>/dev/null; do touch "$HB"; sleep "$HEARTBEAT"; done ) >/dev/null 2>&1 </dev/null &
HB_PID=$!

FINISHED=0
CMD_PID=""
SIGNAL=""

finish_record() {
  # $1 = outcome (settled|crashed), $2 = --step text. Best effort: if this write
  # fails the record stays running with a soon-dead pid, and `fleet sweep` adopts
  # it — the designed fallback, not a failure of this wrapper.
  FINISHED=1
  if ! "$AMICO" fleet finish --session "$SESSION" --outcome "$1" --pid "$$" \
       --step "$2" >>"$LOG" 2>&1; then
    echo "[wrapper] $(date -u +%Y-%m-%dT%H:%M:%SZ) fleet finish failed — record left running; fleet sweep will adopt it" >>"$LOG"
  fi
}

on_exit() {
  if [ -n "${HB_PID:-}" ]; then kill "$HB_PID" 2>/dev/null || true; fi
  if [ "$FINISHED" -ne 1 ]; then
    finish_record crashed "wrapper exited without running the command"
  fi
}
trap on_exit EXIT

forward_signal() {
  SIGNAL="$1"
  if [ -n "$CMD_PID" ]; then kill -TERM "$CMD_PID" 2>/dev/null || true; fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

# ── run, bounded ──────────────────────────────────────────────────────────────
# GNU timeout when present; else the TERM-then-KILL babysitter (no GNU timeout
# on macOS — fleet-status.sh makes the same accommodation). The babysitter's
# killer subshell may leave a harmless orphaned sleep behind when the command
# finishes first; it kills nothing (its kills live in the dead subshell).
TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
RC=0
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" -k "$KILL_AFTER" "$TIMEOUT" "${CMD[@]}" >>"$LOG" 2>&1 &
  CMD_PID=$!
  wait "$CMD_PID" || RC=$?
else
  "${CMD[@]}" >>"$LOG" 2>&1 &
  CMD_PID=$!
  ( sleep "$(dur_seconds "$TIMEOUT")" 2>/dev/null; kill -TERM "$CMD_PID" 2>/dev/null; \
    sleep "$(dur_seconds "$KILL_AFTER")" 2>/dev/null; kill -KILL "$CMD_PID" 2>/dev/null; ) \
    >/dev/null 2>&1 </dev/null &
  KILLER_PID=$!
  wait "$CMD_PID" || RC=$?
  kill "$KILLER_PID" 2>/dev/null || true
  wait "$KILLER_PID" 2>/dev/null || true
fi
trap - TERM INT

# ── the record: finish (the holder's terminal write) ─────────────────────────
if [ "$RC" -eq 0 ]; then
  finish_record settled "exit=0"
elif [ -n "$SIGNAL" ]; then
  finish_record crashed "signal $SIGNAL (exit=$RC)"
else
  finish_record crashed "exit=$RC"
fi

echo "[wrapper] $(date -u +%Y-%m-%dT%H:%M:%SZ) done rc=$RC — log: $LOG" >>"$LOG"
exit "$RC"
