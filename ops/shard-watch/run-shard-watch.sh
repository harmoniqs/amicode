#!/usr/bin/env bash
# run-shard-watch.sh — the nightly client shard-divergence watch (amicode#1306).
#
# Thin plumbing around `amico fleet shard-watch` (the detection core in
# packages/amico-run/src/shard_watch.ts): resolve the bin, forward --dry-run,
# append ONE receipt line on real runs, touch NOTHING on dry-run, and relay the
# check's exit code — divergence (a forked shard, or a live local listener on the
# canonical port that is not the ssh forward) exits nonzero. Escalation to the
# fleet channel happens INSIDE the check (the fleet-alert convention, via
# amico-slack); this wrapper posts nothing itself.
#
# Detection only, always: the check opens every DB READ-ONLY and never runs a
# merge, kill, or any remediation — that is the human-coordinated #1302 flow.
#
# Receipt: ONE JSON line per real run appended to the upgrade-receipts journal:
#   {"receipt_version":1,"ts":"…","verb":"fleet","subcommand":"shard-watch",
#    "kind":"shard-watch","verdict":"clean|divergent","clients":[…],…}
# A bin that dies without producing a parseable receipt line appends NOTHING —
# a malformed journal line is worse than a missing row.
#
# --dry-run: runs the check (reads only, as ever), prints WOULD-DO lines to
# stderr, appends NO receipt. This is the testable seam
# (packages/amico-run/test/shard_watch_wrapper.test.ts).
#
# Configuration (env; the check reads its own config from the same environment):
#   SHARD_WATCH_REPO      ~/armonia/repos/amicode        canonical repo checkout
#   SHARD_WATCH_BIN       $REPO/packages/amico-run/dist/amico.js
#                         node-executable JS entry (build it: pnpm --filter
#                         @amicode/amico-run build); override to point at a
#                         frozen bundle
#   SHARD_WATCH_RECEIPTS  ~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl
#   AMICO_SHARD_CLIENTS   comma-separated client ssh aliases (REQUIRED for a
#                         real check — the check refuses to watch nothing)
#   AMICO_CANONICAL_PORT  4096 (the canonical opencode port)
#   AMICO_SHARD_ALERT_MIN 1 (alert at ≥ 1 missing session id; warn-only below)
#   AMICO_SLACK_FLEET_CHANNEL  the fleet-alert channel (escalation rides the
#                         existing convention; unset = receipt only)
#
# usage: run-shard-watch.sh [--dry-run]
#
# Written for /bin/bash (3.2): no associative arrays, no namerefs.
set -uo pipefail

# --- node resolution (the role-parity ladder: caller's PATH wins) -------------
if ! command -v node >/dev/null 2>&1; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
fi

SELF_NAME="run-shard-watch"

# --- arguments ----------------------------------------------------------------
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) grep '^# ' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "$SELF_NAME: unknown argument: $arg (usage: $0 [--dry-run])" >&2; exit 2 ;;
  esac
done

# --- configuration (defaults per the header table) ----------------------------
AMICODE_REPO="${SHARD_WATCH_REPO:-$HOME/armonia/repos/amicode}"
BIN="${SHARD_WATCH_BIN:-$AMICODE_REPO/packages/amico-run/dist/amico.js}"
RECEIPTS="${SHARD_WATCH_RECEIPTS:-$HOME/.amico/server/upgrade-receipts/upgrade-receipts.jsonl}"

# --- pre-flight (a broken runtime is not a skippable check) --------------------
if ! command -v node >/dev/null 2>&1; then
  echo "$SELF_NAME: FATAL node not found on PATH — cannot run the shard-watch check" >&2
  exit 2
fi
if [ ! -f "$BIN" ]; then
  echo "$SELF_NAME: FATAL shard-watch bin not found: $BIN (set SHARD_WATCH_BIN, or build it: pnpm --filter @amicode/amico-run build)" >&2
  exit 2
fi

# --- run the check (the receipt line is the bin's single-line JSON stdout) -----
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/$SELF_NAME-receipt.XXXXXX")"
ARGS=""
[ "$DRY_RUN" = "1" ] && ARGS="--dry-run"
node "$BIN" fleet shard-watch $ARGS > "$OUT_FILE"
RC=$?

# --- receipt (real runs only; dry-run never touches the journal) ----------------
if [ -s "$OUT_FILE" ] && node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$OUT_FILE" >/dev/null 2>&1; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "$SELF_NAME: WOULD-DO: append receipt to $RECEIPTS" >&2
  else
    mkdir -p "$(dirname "$RECEIPTS")"
    cat "$OUT_FILE" >> "$RECEIPTS"
    echo "$SELF_NAME: receipt appended → $RECEIPTS" >&2
  fi
else
  echo "$SELF_NAME: WARN no parseable receipt line (check exited $RC) — nothing appended" >&2
fi
rm -f "$OUT_FILE"

# --- relay the verdict: divergence → nonzero (dry-run included) -----------------
exit "$RC"
