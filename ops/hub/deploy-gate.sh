#!/usr/bin/env bash
# deploy-gate.sh — the pre-rebuild battery. NO hub restart without this green.
#
# amicode #1725 (2026-10-07): every same-day production break was a SEAM bug —
# frontdoor↔engine↔service↔watchdog contracts unit tests cannot see. Each fix
# grew a regression test, but nothing REQUIRED running them before a deploy.
# This gate is that requirement: one command, every seam test, syntax check,
# derived-config distinctness check, and (on the hub, with a staged binary) an
# isolated boot smoke of the new engine before the swap.
#
# USAGE
#   ops/hub/deploy-gate.sh                     # frontdoor + jev suites, syntax, configs
#   ops/hub/deploy-gate.sh --scope engine      # + materialize drift + engine typecheck/test lanes
#   ops/hub/deploy-gate.sh --staged-binary B   # + boot B isolated: routes, SSE ids, lists
#   AMICODE_GATE_QUICK=1 skips the engine test lane (typecheck still runs).
#
# Exit 0 = deployable. Anything else = STOP — no stage, no swap, no restart.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SCOPE="all"
STAGED_BIN=""
QUICK="${AMICODE_GATE_QUICK:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --scope) SCOPE="${2:?}"; shift 2 ;;
    --staged-binary) STAGED_BIN="${2:?}"; shift 2 ;;
    *) echo "usage: deploy-gate.sh [--scope frontdoor|engine|all] [--staged-binary <path>]"; exit 2 ;;
  esac
done

FAILED=0

# the watchdog's source-of-truth branch differs from the frontdoor's — resolve
# wherever this run can see it (the repo checkout, else the hub's deployed copy)
WATCHDOG=""
for cand in "$HERE/../fleet-watchdog/rss-watchdog.sh" "$HOME/.amico/server/fleet-watchdog/rss-watchdog.sh"; do
  if [ -f "$cand" ]; then WATCHDOG="$cand"; break; fi
done
if [ -z "$WATCHDOG" ]; then
  echo "GATE CANNOT RUN: rss-watchdog.sh not found (repo or hub deploy path)"
  exit 2
fi

run_check() {
  # run_check <name> <command...>
  local name="$1"; shift
  echo "== GATE: $name"
  if "$@"; then
    echo "   PASS"
  else
    echo "   FAIL  << this blocks the deploy"
    FAILED=1
  fi
  echo
}

# ── 1. syntax: everything that would run must parse first ────────────────────
run_check "frontdoor py-compile" python3 -m py_compile "$HERE/hub-frontdoor.py" "$HERE/jev_placement.py"
run_check "watchdog bash -n" bash -n "$WATCHDOG"

# ── 2. derived-config distinctness (the marker-race class: two watchdog
# instances must never share a probe port, pgrep pattern, or log path —
# 2026-10-07's shared-marker bug left a wedged shard un-restarted for 40 min) ─
run_check "watchdog shard-env distinctness" bash -c '
set -u
wd="$1"; tmp=$(mktemp); trap "rm -f \"$tmp\"" EXIT
for i in 1 2 3; do AMICODE_SHARD_INDEX=$i bash "$wd" --print-shard-env >> "$tmp"; done
fail=0
for field in service health_port pattern log inspect_port; do
  n=$(( $(grep "^$field=" "$tmp" | cut -d= -f2- | sort -u | wc -l | tr -d " ") ))
  [ "$n" = "3" ] || { echo "  $field not distinct across shards ($n distinct values)"; fail=1; }
done
exit $fail
' gate "$WATCHDOG"

# ── 3. the seam suites (fake shards + the real frontdoor as a subprocess) ─────
run_check "frontdoor integration suite (the seams)" python3 "$HERE/test_frontdoor.py"
run_check "jev placement unit suite" python3 "$HERE/test_jev_placement.py"

# ── 4. engine scope: the materialize/overlay/engine lanes ────────────────────
if [ "$SCOPE" = "engine" ] || [ "$SCOPE" = "all" ]; then
  ENGINE_DIR="$REPO_ROOT/packages/app-bundle"
  if [ -d "$ENGINE_DIR/.materialized/packages/opencode" ]; then
    run_check "materialize drift gate" bash -c "cd '$REPO_ROOT' && ${BUN:-bun} '$ENGINE_DIR/scripts/drift_gate.mjs'"
    run_check "engine typecheck gate" bash -c "cd '$REPO_ROOT' && bash '$ENGINE_DIR/scripts/engine_typecheck_gate.sh'"
    if [ "$QUICK" != "1" ]; then
      run_check "engine test lane" bash -c "cd '$REPO_ROOT' && bash '$ENGINE_DIR/scripts/engine_test_gate.sh'"
    else
      echo "== GATE: engine test lane (AMICODE_GATE_QUICK=1 — skipped)"
      echo
    fi
  else
    echo "== GATE: engine lanes skipped (no materialized tree in this checkout)"
    echo
  fi
fi

# ── 5. staging smoke: boot the (staged) binary ISOLATED and prove it serves ───
if [ -n "$STAGED_BIN" ]; then
  [ -x "$STAGED_BIN" ] || { echo "staged binary not executable: $STAGED_BIN"; exit 2; }
  SMOKE_PORT="${AMICODE_GATE_SMOKE_PORT:-4197}"
  SMOKE_DATA="$(mktemp -d)"
  SMOKE_CFG="$(mktemp -d)"
  smoke() {
    local pid out code fail=0
    XDG_DATA_HOME="$SMOKE_DATA" XDG_CONFIG_HOME="$SMOKE_CFG" "$STAGED_BIN" serve --port "$SMOKE_PORT" --hostname 127.0.0.1 >/dev/null 2>&1 &
    pid=$!
    for i in $(seq 1 30); do
      curl -sS -o /dev/null -m 1 "http://127.0.0.1:$SMOKE_PORT/config?directory=%2Fhome%2Faaron%2Fharmoniqs%2Fopencode" 2>/dev/null && break
      sleep 1
    done
    for path in "config?directory=%2Fhome%2Faaron%2Fharmoniqs%2Fopencode" "session" "question" "permission"; do
      code="$(curl -sS -o /dev/null -m 8 -w '%{http_code}' "http://127.0.0.1:$SMOKE_PORT/$path" 2>/dev/null)"
      [ "$code" = "200" ] || { echo "  /$path -> $code (want 200)"; fail=1; }
    done
    # the SSE reconnect contract: frames must carry id: lines
    out="$(timeout 4 curl -sN -m 4 "http://127.0.0.1:$SMOKE_PORT/event?directory=%2Fhome%2Faaron%2Fharmoniqs%2Fopencode" 2>/dev/null | head -2)"
    echo "$out" | grep -q "^id: " || { echo "  SSE frames carry no id: lines (replay contract broken)"; fail=1; }
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    return $fail
  }
  run_check "staged binary boot smoke (isolated XDG, port $SMOKE_PORT)" smoke
  rm -rf "$SMOKE_DATA" "$SMOKE_CFG"
  # the smoke pass is the STAMP OF APPROVAL for this exact binary: hub-restart
  # stage accepts the canonical sha OR this one (a gate-approved NEW build),
  # while still refusing binaries that never passed a gate.
  sha256sum "$STAGED_BIN" | awk '{print $1}' > "$HOME/.amico/server/bin/opencode.GATE-APPROVED-sha"
  echo "gate-approved sha recorded: $(sha256sum "$STAGED_BIN" | cut -c1-16)…"
fi

# ── verdict ─────────────────────────────────────────────────────────────────
if [ "$FAILED" != "0" ]; then
  echo "==============================================================="
  echo "GATE FAILED — do not stage/swap/restart the hub."
  echo "==============================================================="
  exit 1
fi
echo "==============================================================="
echo "GATE GREEN — deployable (scope: $SCOPE${STAGED_BIN:+, staged smoke ok})"
echo "==============================================================="
exit 0
