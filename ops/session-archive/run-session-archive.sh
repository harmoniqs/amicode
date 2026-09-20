#!/usr/bin/env bash
# run-session-archive.sh — the nightly classification-aware auto-archive
# cadence (amicode#1304, slice of #1301 session curation).
#
# Wraps the amico CLI's `sessions autoarchive` verb: archives ONLY sessions the
# deterministic junk classifier (#1303) puts in a junk bucket (junk-greeting |
# dead-cast | probe) AND older than the 48 h age gate — sessions with pending
# todos are never archived, and substantive sessions never are. No LLM anywhere
# in this path (the calibrated middle layer is a deliberate future slice).
# Archive is reversible: the verb stamps the engine's `time_archived` field
# through the same primitive `sessions archive` uses — never raw SQL, never
# delete. Restore: `amico sessions restore <id>`.
#
# --dry-run is the DEFAULT: the verb reports count + ids and writes nothing to
# the DB. The nightly cadence runs --apply (the launchd plist / systemd unit
# pass it); manual invocation stays dry unless --apply is explicit.
#
# Receipt: ONE JSON line per run appended to the shared receipts journal —
#   {"receipt_version":1,"ts":"…","kind":"session-archive",
#    "mode":"dry-run"|"apply","scanned":N,"archived":N,"ids":[…]}
# Per the issue's AC, EVERY run receipts (mode distinguishes dry-run from
# apply) — a deliberate difference from skill-freshness, whose dry-run appends
# none. A hard failure (missing DB / CLI failure) appends an error-marked
# receipt and exits nonzero.
#
# Configuration (env, defaults documented here):
#   SESSION_ARCHIVE_DB        $OPENCODE_DB → ~/.local/share/opencode/opencode.db
#                             (the same resolution order the verb and the
#                             open-threads skill use; the canonical DB is the
#                             only writer target — client DBs are read-only)
#   SESSION_ARCHIVE_AMICO     ~/.amico/ops/papers-digest/bin/amico.js
#                             (the frozen-bundle pattern — see ops/README.md)
#   SESSION_ARCHIVE_RECEIPTS  ~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl
#   AMICODE_OPS_DIR           the retention preference dir (gate: the
#                             `autoarchive_hours` key of session-retention.json)
#
# Written for macOS /bin/bash (3.2): no associative arrays, no namerefs.
set -uo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

SELF_NAME="run-session-archive"

# --- arguments ---------------------------------------------------------------
# mode: dry-run unless --apply is explicit (the cadence units pass --apply).
MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    --dry-run) MODE="dry-run" ;;
    -h|--help) grep '^# ' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "$SELF_NAME: unknown argument: $arg (usage: $0 [--apply] [--dry-run])" >&2; exit 2 ;;
  esac
done

# --- configuration (defaults per the header table) ---------------------------
AMICO="${SESSION_ARCHIVE_AMICO:-$HOME/.amico/ops/papers-digest/bin/amico.js}"
RECEIPTS="${SESSION_ARCHIVE_RECEIPTS:-$HOME/.amico/server/upgrade-receipts/upgrade-receipts.jsonl}"
DB="${SESSION_ARCHIVE_DB:-${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}}"
TS_ISO="$(date -u +%FT%TZ)"

# --- receipt writer (one JSON line per run, hard failures included) -----------
# append_receipt <json-fields…> — a single pre-rendered fields string.
append_receipt() {
  local line="{\"receipt_version\":1,\"ts\":\"$TS_ISO\",\"kind\":\"session-archive\",$1}"
  mkdir -p "$(dirname "$RECEIPTS")"
  printf '%s\n' "$line" >> "$RECEIPTS"
  echo "$SELF_NAME: receipt appended → $RECEIPTS" >&2
}

# --- pre-flight (a broken runtime is a hard failure, never a silent skip) -----
# Pre-flight failures exit nonzero WITHOUT a receipt (the skill-freshness
# convention: nothing ran, nothing to receipt; the stderr log carries it).
if ! command -v node >/dev/null 2>&1; then
  echo "$SELF_NAME: FATAL node not found on PATH — cannot run the amico CLI" >&2
  exit 1
fi
if [ ! -f "$AMICO" ]; then
  echo "$SELF_NAME: FATAL amico bundle not found: $AMICO (set SESSION_ARCHIVE_AMICO)" >&2
  exit 1
fi
if [ ! -f "$DB" ]; then
  echo "$SELF_NAME: FATAL session DB not found: $DB (set SESSION_ARCHIVE_DB)" >&2
  exit 1
fi

# --- run the verb (the ONLY writer path — the verb's archive primitive) -------
args=(sessions autoarchive --db "$DB")
[ "$MODE" = "apply" ] && args+=(--apply)
if ! OUT="$(node "$AMICO" "${args[@]}" 2>/dev/null)"; then
  echo "$SELF_NAME: FATAL sessions autoarchive exited nonzero" >&2
  append_receipt "\"mode\":\"$MODE\",\"error\":\"cli-failed\""
  exit 1
fi

# --- receipt fields from the verb's JSON ---------------------------------------
FIELDS="$(node -e '
  let r = null;
  try { r = JSON.parse(process.argv[1]); } catch { /* verb output lost */ }
  if (!r || r.error) {
    process.stdout.write("\"mode\":\"" + process.argv[2] + "\",\"error\":\"bad-verb-output\"");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    mode: process.argv[2],
    scanned: r.scanned,
    archived: r.archived,
    ids: r.candidate_ids,
  }).slice(1, -1));
' "$OUT" "$MODE")"
echo "$SELF_NAME: $FIELDS" >&2
append_receipt "$FIELDS"

case "$FIELDS" in
  *'"error"'*) exit 1 ;;
  *) exit 0 ;;
esac
