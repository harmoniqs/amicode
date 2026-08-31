#!/usr/bin/env bash
# hub-upgrade-smoke.sh — boot-smoke a candidate SERVER binary against a COPY
# of the production chat DB before any swap touches the hub (amicode#652).
#
# Born from the 2026-08-30 incident: a new binary boot-validated "by
# crash-looping systemd against production" (29 restarts, hub down) because
# its pending migration collided with drifted-but-legal DB state. This script
# is that lesson, productized — the same harness that diagnosed it:
#
#   snapshot the live DB (sqlite .backup API — WAL-consistent, read-only)
#     → boot the candidate against the snapshot in an isolated XDG data dir
#     → expect "listening" within the budget
#     → verify the migration journal reconciled (post >= pre)
#     → kill, report PASS/FAIL with the boot error verbatim
#
# Usage: hub-upgrade-smoke.sh <candidate-binary> [port]
#   exit 0 = PASS (candidate may be staged/swapped)   1 = FAIL   2 = usage
#
# The production DB is never written: the snapshot is taken via a read-only
# connection and the candidate boots against the COPY with XDG_DATA_HOME
# pointing at a fresh temp dir. Production WAL/SHM are untouched.
set -uo pipefail

CANDIDATE="${1:-}"
PORT="${2:-4098}"
BUDGET_S="${AMICODE_SMOKE_BUDGET:-25}"
DB="${OPENCODE_DB_PATH:-$HOME/.local/share/opencode/opencode.db}"

usage() { echo "usage: hub-upgrade-smoke.sh <candidate-binary> [port]  (default port 4098)"; exit 2; }
[ -n "$CANDIDATE" ] || usage
[ -x "$CANDIDATE" ] || { echo "FAIL: $CANDIDATE is not executable"; exit 1; }
[ -f "$DB" ] || { echo "FAIL: production DB not found at $DB"; exit 1; }

command -v python3 >/dev/null || { echo "FAIL: python3 required (snapshot via the sqlite backup API)"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hub-smoke-XXXXXX")"
trap 'kill "$SMOKE_PID" 2>/dev/null; rm -rf "$WORK"' EXIT
mkdir -p "$WORK/xdg/opencode"

PRE="$(python3 - "$DB" "$WORK/xdg/opencode/opencode.db" <<'EOF'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
n = dst.execute("select count(*) from migration").fetchone()[0]
dst.close(); src.close()
print(n)
EOF
)" || { echo "FAIL: snapshot of $DB failed"; exit 1; }
echo "smoke: snapshot ok (journal rows pre=$PRE)"

LOG="$WORK/boot.log"
XDG_DATA_HOME="$WORK/xdg" OPENCODE_DB=opencode.db "$CANDIDATE" serve --port="$PORT" --hostname=127.0.0.1 > "$LOG" 2>&1 &
SMOKE_PID=$!

UP=0
for _ in $(seq 1 "$BUDGET_S"); do
  sleep 1
  if grep -q "opencode server listening" "$LOG" 2>/dev/null; then UP=1; break; fi
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then break; fi
done

if [ "$UP" != "1" ]; then
  echo "FAIL: candidate did not reach 'listening' within ${BUDGET_S}s — boot output:"
  sed -e 's/\x1b\[[0-9;]*m//g' "$LOG" | head -10
  exit 1
fi

POST="$(python3 - "$WORK/xdg/opencode/opencode.db" <<'EOF'
import sqlite3, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
print(con.execute("select count(*) from migration").fetchone()[0])
EOF
)"
kill "$SMOKE_PID" 2>/dev/null
wait "$SMOKE_PID" 2>/dev/null

if [ -z "$POST" ] || [ "$POST" -lt "$PRE" ]; then
  echo "FAIL: journal did not reconcile (pre=$PRE post=${POST:-none})"
  exit 1
fi

echo "PASS: candidate serves against the DB copy (journal $PRE → $POST, isolated at $WORK/xdg)"
exit 0
