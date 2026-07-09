#!/usr/bin/env bash
#
# pasqal-harness.sh — stand up the Pasqal chat harness, then talk to Amico in plain English.
#
# Seeds a stable working directory from the committed connector scripts (single
# source of truth), health-checks the environment, launches the vendored amicode
# server (`opencode serve`), and prints a chat URL. You then open that URL and
# drive the whole Piccolo -> Pulser -> Pasqal Cloud pipeline conversationally —
# the seeded AGENTS.md tells Amico how.
#
# The harness NEVER touches credentials. You type your Pasqal username/password/
# project_id into the chat; Amico passes them as env vars on a single bash call
# and never writes them anywhere (see AGENTS.md, "Credentials protocol").
#
# Usage:
#   ./pasqal-harness.sh              # seed if needed, health-check, launch, print URL
#   ./pasqal-harness.sh --fresh      # wipe the working dir and reseed from the repo
#   ./pasqal-harness.sh --restart    # kill a running harness server, then relaunch
#   ./pasqal-harness.sh --status     # show the chat URL if a server is running
#   ./pasqal-harness.sh --stop       # stop a running harness server
#   ./pasqal-harness.sh -h|--help
#
# Environment overrides:
#   PASQAL_HARNESS_DIR         working dir (default: ~/.pasqal-harness/run)
#   PASQAL_HARNESS_PORT        server port (default: 4270)
#   PASQAL_HARNESS_OPENCODE_BIN  path to the vendored `opencode` binary
#   AMICO_JULIA_PROJECT        Julia project for solves (default: ~/.amico/julia)

set -euo pipefail

# ----------------------------------------------------------------------------- paths
resolve_dir() { # portable `dirname $(realpath ..)` for the script's own location
  local src="${BASH_SOURCE[0]}"
  while [ -h "$src" ]; do
    local dir; dir="$(cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd)"
    src="$(readlink "$src")"; [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd
}
SCRIPT_DIR="$(resolve_dir)"                        # .../pasqal-connector/harness
CONNECTOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"      # .../pasqal-connector
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"  # amicode repo root

WORKDIR="${PASQAL_HARNESS_DIR:-$HOME/.pasqal-harness/run}"
PORT="${PASQAL_HARNESS_PORT:-4270}"
JULIA_PROJECT="${AMICO_JULIA_PROJECT:-$HOME/.amico/julia}"

# ----------------------------------------------------------------------------- ui
bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); red=$(printf '\033[31m')
grn=$(printf '\033[32m'); ylw=$(printf '\033[33m'); rst=$(printf '\033[0m')
info() { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$grn" "$rst" "$*"; }
warn() { printf '  %s!%s %s\n' "$ylw" "$rst" "$*"; }
die()  { printf '%serror:%s %s\n' "$red" "$rst" "$*" >&2; exit 1; }

# ----------------------------------------------------------------------------- args
FRESH=false; RESTART=false; MODE=launch
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh)   FRESH=true ;;
    --restart) RESTART=true ;;
    --status)  MODE=status ;;
    --stop)    MODE=stop ;;
    --port)    shift; PORT="${1:?--port needs a value}" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '1d'; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

PIDFILE="$WORKDIR/server.pid"
PORTFILE="$WORKDIR/server.port"
LOGFILE="$WORKDIR/server.log"

# ----------------------------------------------------------------------------- server helpers
server_pid() { [ -f "$PIDFILE" ] && cat "$PIDFILE" 2>/dev/null || true; }
server_alive() { local p; p="$(server_pid)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
workdir_abs() { cd "$WORKDIR" && pwd -P; }
chat_url() {
  local port="$1" path b64
  path="$(workdir_abs)"
  b64="$(python3 -c 'import base64,sys; print(base64.urlsafe_b64encode(sys.argv[1].encode()).decode())' "$path")"
  printf 'http://127.0.0.1:%s/%s/session' "$port" "$b64"
}
stop_server() {
  if server_alive; then
    local p; p="$(server_pid)"
    kill "$p" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do server_alive || break; sleep 0.3; done
    server_alive && kill -9 "$p" 2>/dev/null || true
    ok "stopped server (pid $p)"
  else
    info "  no running harness server"
  fi
  rm -f "$PIDFILE"
}

# ----------------------------------------------------------------------------- status / stop shortcuts
if [ "$MODE" = status ]; then
  if server_alive; then
    ok "harness server running (pid $(server_pid), port $(cat "$PORTFILE" 2>/dev/null || echo '?'))"
    info "  chat: $(chat_url "$(cat "$PORTFILE" 2>/dev/null || echo "$PORT")")"
  else
    info "  harness server not running"
  fi
  exit 0
fi
if [ "$MODE" = stop ]; then stop_server; exit 0; fi

# ----------------------------------------------------------------------------- resolve the vendored opencode binary
find_binary() {
  if [ -n "${PASQAL_HARNESS_OPENCODE_BIN:-}" ]; then
    [ -x "$PASQAL_HARNESS_OPENCODE_BIN" ] && { printf '%s' "$PASQAL_HARNESS_OPENCODE_BIN"; return 0; }
    return 1
  fi
  # candidate repo roots: this worktree, plus every other git worktree (the
  # binary is built/gitignored and usually lives only in the main clone).
  local roots=("$REPO_ROOT")
  if command -v git >/dev/null 2>&1; then
    while IFS= read -r line; do
      case "$line" in worktree\ *) roots+=("${line#worktree }") ;; esac
    done < <(git -C "$CONNECTOR_DIR" worktree list --porcelain 2>/dev/null)
  fi
  local root cand
  for root in "${roots[@]}"; do
    for cand in "$root"/packages/extension/vendor/opencode/*/opencode; do
      [ -x "$cand" ] && { printf '%s' "$cand"; return 0; }
    done
  done
  return 1
}

# ----------------------------------------------------------------------------- seed the working dir
seed_workdir() {
  info "${bold}Seeding${rst} working dir: $WORKDIR"
  rm -rf "$WORKDIR"
  mkdir -p "$WORKDIR/.opencode"
  # connector scripts (flattened — the scripts import each other as siblings)
  cp "$CONNECTOR_DIR/pasqal_connect.py" "$WORKDIR/"
  cp "$CONNECTOR_DIR/requirements.txt"  "$WORKDIR/"
  cp "$CONNECTOR_DIR"/spike/*.py "$WORKDIR/"
  cp "$CONNECTOR_DIR"/spike/*.jl "$WORKDIR/"
  cp -R "$CONNECTOR_DIR/spike/tests" "$WORKDIR/tests"
  # harness-owned artifacts
  cp "$SCRIPT_DIR/AGENTS.md" "$WORKDIR/AGENTS.md"
  cp "$SCRIPT_DIR"/pulses/*.toml "$WORKDIR/"
  cp "$SCRIPT_DIR/opencode/opencode.json" "$WORKDIR/.opencode/opencode.json"
  # prune build cruft that may ride along
  find "$WORKDIR" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
  ok "seeded $(ls "$WORKDIR"/*.py "$WORKDIR"/*.jl "$WORKDIR"/*.toml 2>/dev/null | wc -l | tr -d ' ') scripts/pulses + AGENTS.md"
}

# ----------------------------------------------------------------------------- health checks
health_check() {
  info "${bold}Health check${rst}"
  # binary
  BIN="$(find_binary)" || die "vendored opencode binary not found. Build it in the main clone (npm run fetch:opencode) or set PASQAL_HARNESS_OPENCODE_BIN."
  ok "opencode binary: $BIN"
  if [ -f "$(dirname "$BIN")/.source" ]; then info "    ${dim}$(cat "$(dirname "$BIN")/.source")${rst}"; fi
  # python — the REAL symbols the scripts import (not .__version__, which the
  # pasqal-cloud deprecation shim does not expose)
  if err="$(python3 -c 'import pulser
from pulser import Register, Sequence, Pulse, AnalogDevice
from pasqal_cloud import PasqalCloudConnection, RemoteEmuFreeBackend
print(pulser.__version__)' 2>&1)"; then
    ok "python deps ok (pulser $err, pasqal-cloud imports resolve)"
  else
    printf '%s\n' "$err" | sed 's/^/    /' >&2
    die "python deps missing/broken. Install with:  python3 -m pip install -r \"$CONNECTOR_DIR/requirements.txt\""
  fi
  # julia — non-fatal (pre-solved pulses + translation of an existing pulse.toml
  # work without it; only live re-solves need it)
  if [ -f "$JULIA_PROJECT/Project.toml" ] && command -v julia >/dev/null 2>&1; then
    ok "julia project: $JULIA_PROJECT"
  else
    warn "julia project or binary not found ($JULIA_PROJECT) — live re-solves (solve_*.jl) will fail; pre-solved demos still work."
  fi
}

# ----------------------------------------------------------------------------- launch
launch_server() {
  cd "$WORKDIR"
  : > "$LOGFILE"
  nohup "$BIN" serve --port "$PORT" --hostname 127.0.0.1 >>"$LOGFILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  # wait for the "listening on http://127.0.0.1:PORT" line (capture the ACTUAL port)
  local actual_port="" i
  for i in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' "--- server.log ---" >&2; tail -20 "$LOGFILE" >&2
      die "server exited during startup (see $LOGFILE)"
    fi
    actual_port="$(grep -oE 'listening on https?://127\.0\.0\.1:[0-9]+' "$LOGFILE" 2>/dev/null | grep -oE '[0-9]+$' | tail -1 || true)"
    [ -n "$actual_port" ] && break
    sleep 0.5
  done
  [ -z "$actual_port" ] && { tail -20 "$LOGFILE" >&2; die "server did not report a listening port within 30s (see $LOGFILE)"; }
  PORT="$actual_port"
  echo "$PORT" > "$PORTFILE"
  # confirm it's actually serving HTTP
  local url code
  url="$(chat_url "$PORT")"
  for i in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] && break
    sleep 0.3
  done
  ok "server up (pid $pid, port $PORT), chat URL responds HTTP $code"
  if [ "$code" != "200" ]; then warn "expected HTTP 200 on the chat URL; got $code — open it manually to confirm."; fi
}

# ----------------------------------------------------------------------------- main
info ""
info "${bold}Pasqal chat harness${rst}"

# already-running guard
if server_alive && [ "$RESTART" = false ] && [ "$FRESH" = false ]; then
  info ""
  ok "harness already running (pid $(server_pid), port $(cat "$PORTFILE" 2>/dev/null || echo "$PORT"))"
  info "  chat: $(chat_url "$(cat "$PORTFILE" 2>/dev/null || echo "$PORT")")"
  info "  (${dim}--restart to relaunch, --fresh to wipe+reseed, --stop to stop${rst})"
  exit 0
fi
if [ "$RESTART" = true ] || [ "$FRESH" = true ]; then stop_server >/dev/null 2>&1 || true; fi

info ""
# seed if the working dir hasn't been seeded, or --fresh
if [ ! -f "$WORKDIR/AGENTS.md" ] || [ "$FRESH" = true ]; then
  seed_workdir
else
  info "${bold}Reusing${rst} working dir: $WORKDIR ${dim}(--fresh to reseed from repo)${rst}"
fi

info ""
health_check

info ""
info "${bold}Launching${rst} amicode server"
launch_server

# ----------------------------------------------------------------------------- banner
URL="$(chat_url "$PORT")"
info ""
info "${bold}────────────────────────────────────────────────────────────${rst}"
info "${bold}Open this in your browser and talk to Amico in plain English:${rst}"
info ""
info "  ${grn}$URL${rst}"
info ""
info "${dim}Credentials: type your Pasqal username / password / project_id into the${rst}"
info "${dim}chat when Amico asks. It passes them as env vars on one bash call and${rst}"
info "${dim}never stores them. Real-QPU submits always require an explicit 'yes'.${rst}"
info ""
info "${bold}Try saying:${rst}"
info "  • \"Run the connectivity test against EMU_FREE.\"            ${dim}(Task A)${rst}"
info "  • \"Solve an X gate, then translate and simulate it.\"       ${dim}(Task B)${rst}"
info "  • \"Do the atom-position sweep and show me the chart.\"      ${dim}(Task E)${rst}"
info "  • \"Submit the best Bell pulse to Pasqal Cloud.\"           ${dim}(Task F)${rst}"
info "  • \"Show the W-state geometry demo — triangle vs chain.\"   ${dim}(Task G)${rst}"
info "  • \"Run the pair-packing demo.\"                            ${dim}(Task H)${rst}"
info "  • \"Run the test harness.\"                                 ${dim}(Task D)${rst}"
info ""
info "${dim}logs: $LOGFILE   •   stop: $0 --stop${rst}"
info "${bold}────────────────────────────────────────────────────────────${rst}"
