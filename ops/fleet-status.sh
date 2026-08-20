#!/usr/bin/env bash
# fleet-status.sh — collect fleet health into ~/.amico/ops/fleet-status.json
# for the Amicode dashboard widget. Run on the canonical server (the mini);
# safe to run any time, read-only everywhere. Wired to launchd every 5 min.
set -uo pipefail

OUT="$HOME/.amico/ops/fleet-status.json"
TMP="$OUT.tmp"
DB="$HOME/.local/share/opencode/opencode-dev.db"
SYNCLOG="$HOME/.amico/sync.log"

# --- devices: alias|host pairs (edit here as the fleet grows) ---------------
DEVICES=("mini:127.0.0.1" "macbook:macbook" "erlich:erlich")

# Bounded ssh probe — no GNU timeout on macOS, and ConnectTimeout alone does
# NOT bound an in-band stall (observed 2026-08-08: Tailscale SSH to erlich
# parks on an interactive re-auth banner forever, hanging the whole script so
# fleet-status.json silently goes stale). Background + kill after 8 s.
ssh_probe() {
  local host="$1" pid killer rc
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" true 2>/dev/null &
  pid=$!
  ( sleep 8; kill "$pid" 2>/dev/null ) & killer=$!
  wait "$pid" 2>/dev/null; rc=$?
  kill "$killer" 2>/dev/null; wait "$killer" 2>/dev/null
  return $rc
}

dev_rows=""
for pair in "${DEVICES[@]}"; do
  name="${pair%%:*}"; host="${pair#*:}"
  if [ "$host" = "127.0.0.1" ]; then
    reachable=true; detail="this machine"
  else
    if ssh_probe "$host"; then
      reachable=true; detail="ssh ok"
    else
      reachable=false; detail="ssh failed"
    fi
  fi
  dev_rows="$dev_rows{\"name\":\"$name\",\"reachable\":$reachable,\"detail\":\"$detail\"},"
done
dev_rows="[${dev_rows%,}]"

# --- canonical chat DB --------------------------------------------------------
sessions="null"; last_session="null"
if [ -f "$DB" ]; then
  read -r sessions last_session <<<"$(sqlite3 "$DB" "SELECT COUNT(*), COALESCE(datetime(MAX(time_updated)/1000,'unixepoch'),'') FROM session;" 2>/dev/null | awk -F'|' '{print $1, $2}')"
  sessions="${sessions:-null}"; last_session="${last_session:-null}"
fi
server_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:4096/session 2>/dev/null || echo 000)"

# --- server guard: is the running server holding the CANONICAL db? ------------
# (2026-08-08 incident: a vendor binary refresh flipped the build channel and
#  the server silently served a fresh opencode-local.db for hours — panels saw
#  an empty history while opencode-dev.db sat untouched on disk. Now caught
#  here within one 5-min cycle, with a notification on state transition.)
guard_ok=true; guard_notes=""
srv_pid="$(launchctl list 2>/dev/null | awk '/co\.harmoniqs\.amicode-server/ {print $1}')"
srv_db="none"; served="null"
if [ -n "$srv_pid" ] && [ "$srv_pid" != "-" ]; then
  srv_db="$(lsof -p "$srv_pid" 2>/dev/null | grep -oE 'opencode-[a-z]+\.db' | sort -u | head -1)"
  srv_db="${srv_db:-none}"
  if [ "$srv_db" != "opencode-dev.db" ]; then
    guard_ok=false; guard_notes="${guard_notes}server holds ${srv_db} not opencode-dev.db; "
  fi
else
  guard_ok=false; guard_notes="${guard_notes}server not running; "
fi
if [ "$server_code" = "200" ]; then
  served="$(curl -s --max-time 6 'http://127.0.0.1:4096/session?limit=1000' 2>/dev/null \
    | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(len(d if isinstance(d,list) else d.get("sessions",[])))' 2>/dev/null || echo null)"
  served="${served:-null}"
  # the /session endpoint filters by the server's project, so it never matches
  # the on-disk count exactly — flag only a dramatic shortfall (< 50 %).
  if [ "$served" != "null" ] && [ "$sessions" != "null" ] && [ "$sessions" -ge 100 ] 2>/dev/null; then
    if [ "$served" -lt $(( sessions / 2 )) ] 2>/dev/null; then
      guard_ok=false; guard_notes="${guard_notes}serving only ${served} of ${sessions} sessions; "
    fi
  fi
fi

# notify once per distinct bad state (launchd re-runs every 5 min)
GSTATE="$HOME/.amico/ops/fleet-status.guard-state"
prev_guard="$(cat "$GSTATE" 2>/dev/null || echo ok)"
if [ "$guard_ok" = false ]; then
  sig="bad: ${guard_notes}"
  if [ "$prev_guard" != "$sig" ]; then
    osascript -e "display notification \"${guard_notes}— see ~/.amico/ops/fleet-status.json\" with title \"Amicode fleet: chat server\"" 2>/dev/null || true
  fi
  echo "$sig" > "$GSTATE"
else
  echo ok > "$GSTATE"
fi

# --- vault sync freshness -----------------------------------------------------
sync_age_min="null"; sync_clean="null"
if [ -f "$SYNCLOG" ]; then
  last_done="$(grep "done$" "$SYNCLOG" | tail -1 | sed -E 's/^\[([^]]+)\].*/\1/')"
  if [ -n "$last_done" ]; then
    last_epoch="$(date -j -f "%Y-%m-%dT%H:%M:%S%z" "$last_done" +%s 2>/dev/null || echo 0)"
    now_epoch="$(date +%s)"
    [ "$last_epoch" -gt 0 ] && sync_age_min=$(( (now_epoch - last_epoch) / 60 ))
  fi
  if tail -20 "$SYNCLOG" | grep -qE "fatal:|CONFLICT|no tracking information"; then
    sync_clean=false
  else
    sync_clean=true
  fi
fi

# --- code repos (no daemon by design — only commits cross machines; the ritual
#     is wip-sync.sh). Read-only scan of LOCAL ~/harmoniqs repos: dirty count +
#     ahead/behind as of last fetch (no network in a 5-min launchd job). -------
repo_rows=""
shopt -s nullglob
for gd in "$HOME"/harmoniqs/*/.git "$HOME"/harmoniqs/packages/*/.git "$HOME"/harmoniqs/demos/*/.git; do
  r="${gd%/.git}"
  name="$(basename "$r")"
  branch="$(git -C "$r" branch --show-current 2>/dev/null)"; branch="${branch:-DETACHED}"
  dirty="$(git -C "$r" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  ahead=0; behind=0
  ab="$(git -C "$r" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)"
  if [ -n "$ab" ]; then behind="${ab%%[[:space:]]*}"; ahead="${ab##*[[:space:]]}"; fi
  wips="$( { git -C "$r" branch --list 'wip/*' --format='%(refname:short)' 2>/dev/null; \
             git -C "$r" branch -r --list 'origin/wip/*' --format='%(refname:short)' 2>/dev/null | sed 's|^origin/||'; } \
           | sort -u | tr '\n' ',' )"
  repo_rows="$repo_rows{\"name\":\"$name\",\"branch\":\"$branch\",\"dirty\":$dirty,\"ahead\":$ahead,\"behind\":$behind,\"wip_branches\":\"${wips%,}\"},"
done
shopt -u nullglob
repo_rows="[${repo_rows%,}]"

cat > "$TMP" <<EOF
{
  "collected_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "devices": $dev_rows,
  "chat_db": { "sessions": $sessions, "last_session": "$last_session", "server_http": "$server_code" },
  "server_guard": { "ok": $guard_ok, "pid": "$srv_pid", "db_file": "$srv_db", "served_sessions": $served, "notes": "${guard_notes% }" },
  "vault_sync": { "age_minutes": $sync_age_min, "clean": $sync_clean },
  "repos": $repo_rows
}
EOF
mv "$TMP" "$OUT"
