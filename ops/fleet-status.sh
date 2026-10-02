#!/usr/bin/env bash
# fleet-status.sh — collect fleet health into ~/.amico/ops/fleet-status.json
# for the Amicode dashboard widget. Run on the canonical server (erlich, the
# Linux hub); safe to run any time, read-only everywhere. Wired to the systemd
# cadence (co.harmoniqs.fleet-status.timer, #1561) every 5 min.
#
# #1657: the probes are hub-native. The mini-era script assumed macOS (launchd,
# BSD date, sqlite3 CLI) and hardcoded its first device alias as "this machine"
# — every one of those assumptions failed on the erlich hub and the widget
# showed a wrong, worrying fleet. Now: this machine names itself from the fleet
# config, the server guard reads the engine's /proc environment, the chat DB is
# read via python3 (no sqlite3 CLI on the hub), and sync-log parsing is portable.
set -uo pipefail

OUT="${FLEET_STATUS_OUT:-$HOME/.amico/ops/fleet-status.json}"
TMP="$OUT.tmp"
DB="$HOME/.local/share/opencode/opencode.db"  # the pinned canonical name (amicode-server.sh pins OPENCODE_DB=opencode.db)
SYNCLOG="$HOME/.amico/sync.log"
FLEETJSON="$HOME/.amico/ops/fleet/fleet.json"

# --- devices: this machine names itself; members are probed -------------------
# The canonical server's identity comes from the fleet config's sshAlias (the
# hub wrote it when the role was assigned), hostname as fallback. Members are
# probed by ssh alias — edit the list as the fleet grows.
local_name="$(hostname 2>/dev/null | cut -d. -f1)"
if [ -f "$FLEETJSON" ]; then
  cfg_alias="$(grep -oE '"sshAlias"[[:space:]]*:[[:space:]]*"[^"]*"' "$FLEETJSON" | head -1 | sed 's/.*"sshAlias"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  [ -n "$cfg_alias" ] && local_name="$cfg_alias"
fi
MEMBERS=("macbook" "mini")

# Bounded ssh probe — no GNU timeout on macOS clients, and ConnectTimeout alone
# does NOT bound an in-band stall (observed 2026-08-08: a Tailscale SSH probe
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

dev_rows="{\"name\":\"$local_name\",\"reachable\":true,\"detail\":\"this machine\"},"
for m in "${MEMBERS[@]}"; do
  if ssh_probe "$m"; then
    reachable=true; detail="ssh ok"
  else
    reachable=false; detail="ssh failed"
  fi
  dev_rows="$dev_rows{\"name\":\"$m\",\"reachable\":$reachable,\"detail\":\"$detail\"},"
done
dev_rows="[${dev_rows%,}]"

# --- canonical chat DB (python3 reader — no sqlite3 CLI on the hub) -----------
sessions="null"; last_session="null"
if [ -f "$DB" ]; then
  stats="$(python3 - "$DB" 2>/dev/null <<'PY'
import sqlite3, sys
try:
    con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
    n, last = con.execute(
        "SELECT COUNT(*), COALESCE(datetime(MAX(time_updated)/1000,'unixepoch'),'') FROM session"
    ).fetchone()
    print(n, last)
except Exception:
    pass
PY
)"
  sessions="${stats%% *}";   [ -n "$sessions" ]     || sessions="null"
  last_session="${stats#* }"; [ -n "$last_session" ] || last_session="null"
fi
server_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:4096/session 2>/dev/null || echo 000)"

# --- server guard: the engine process must hold the CANONICAL db -------------
# (2026-08-08 incident: a vendor binary refresh flipped the build channel and
# the server silently served a fresh DB for hours. Now caught within one 5-min
# cycle.) The mini-era script probed launchd for the server pid; the hub runs
# systemd + the #1561 chain (frontdoor → service → engine), and the engine is
# the opencode process whose environment carries OPENCODE_DB and no OPENCODE_PID
# (session-runner children carry both). /proc is the Linux hub's ground truth.
guard_ok=true; guard_notes=""; srv_pid=""; srv_db="none"; served="null"
for pid in $(pgrep -x opencode 2>/dev/null); do
  env="$(tr '\0' '\n' < /proc/$pid/environ 2>/dev/null)" || continue
  db="$(printf '%s\n' "$env" | grep -E '^OPENCODE_DB=' | head -1 | cut -d= -f2-)"
  is_child="$(printf '%s\n' "$env" | grep -cE '^OPENCODE_PID=')"
  if [ -n "$db" ] && [ "$is_child" -eq 0 ]; then
    srv_pid="$pid"; srv_db="$(basename "$db")"; break
  fi
done
if [ -z "$srv_pid" ]; then
  guard_ok=false; guard_notes="${guard_notes}server not running; "
elif [ "$srv_db" != "opencode.db" ]; then
  guard_ok=false; guard_notes="${guard_notes}server holds ${srv_db} not opencode.db; "
fi
if [ "$server_code" = "200" ]; then
  served="$(curl -s --max-time 6 'http://127.0.0.1:4096/session?limit=1000' 2>/dev/null \
    | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(len(d if isinstance(d,list) else d.get("sessions",[])))' 2>/dev/null || echo null)"
  served="${served:-null}"
  # served is INFORMATIONAL only. The endpoint is paginated (a 100-session
  # page) and filters by the serving project's directory, so it can never be
  # compared against the raw on-disk table count — the mini-era shortfall
  # heuristic compared exactly those two and false-alarmed on the hub (its
  # original target, the DB-channel flip, is caught by the pid+db check above).
fi

# notify once per distinct bad state (the cadence re-runs every 5 min)
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

# --- vault sync freshness (portable parsing — no BSD date on the hub) ---------
# The hub's sync log is whatever armonia-sync-once last wrote here; if the host
# runs no client-style sync loop the log may be absent or long-stale — report
# the truth (age + a state note), never a null born from a failed date call.
sync_age_min="null"; sync_clean="null"; sync_state="ok"
if [ -f "$SYNCLOG" ]; then
  last_done="$(grep "done$" "$SYNCLOG" | tail -1 | sed -E 's/^\[([^]]+)\].*/\1/')"
  if [ -n "$last_done" ]; then
    sync_age_min="$(python3 -c '
import sys, datetime
try:
    t = datetime.datetime.strptime(sys.argv[1].strip(), "%Y-%m-%dT%H:%M:%S%z")
    print(max(0, int((datetime.datetime.now(datetime.timezone.utc) - t.astimezone(datetime.timezone.utc)).total_seconds() // 60)))
except Exception:
    print("null")
' "$last_done" 2>/dev/null)"
  else
    sync_state="no completed cycle in the log"
  fi
  if tail -20 "$SYNCLOG" | grep -qE "fatal:|CONFLICT|no tracking information"; then
    sync_clean=false
  else
    sync_clean=true
  fi
else
  sync_state="not-applicable: no client sync loop on this host"
fi

# --- code repos (no daemon by design — only commits cross machines; the ritual
#     is wip-sync.sh). Read-only scan of LOCAL ~/harmoniqs repos: dirty count +
#     ahead/behind as of last fetch (no network in a 5-min cadence job). -------
repo_rows=""
shopt -s nullglob
for gd in "$HOME"/harmoniqs/*/.git "$HOME"/harmoniqs/packages/*/.git "$HOME"/harmoniqs/demos/*/.git; do
  r="${gd%/.git}"
  name="$(basename "$r")"
  branch="$(git -C "$r" branch --show-current 2>/dev/null)"; branch="${branch:-DETACHED}"
  dirty="$(git -C "$r" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  ahead=0; behind=0
  # rev-list --count prints "behind<TAB>ahead"; split on whitespace robustly —
  # the inherited parameter-expansion split emitted an empty token when both
  # counts were present, corrupting the JSON (observed in the #1657 verify run).
  ab="$(git -C "$r" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null | tr '\t' ' ')"
  if [ -n "$ab" ]; then
    behind="$(awk '{print $1}' <<<"$ab")"; behind="${behind:-0}"
    ahead="$(awk '{print $2}' <<<"$ab")"; ahead="${ahead:-0}"
  fi
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
  "vault_sync": { "age_minutes": $sync_age_min, "clean": $sync_clean, "state": "$sync_state" },
  "repos": $repo_rows
}
EOF
mv "$TMP" "$OUT"
