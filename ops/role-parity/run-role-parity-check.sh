#!/usr/bin/env bash
# run-role-parity-check.sh — the nightly role-parity pin cadence (amicode#806,
# obligation O8: the pin-behind-HEAD check rides the doctor's fleet cadence
# on the vault-visible machine and files a chore issue on drift — a pin is
# only loud if something runs it).
#
# Runs the pin check CLI (packages/extension/scripts/role_parity_check.mts)
# against the role-card parity fixtures' pin record
# (packages/extension/test/fixtures/vault-agents/pin.json — the engine-neutral
# role definitions the parity suite pinned, at the amicissimo vault revision
# it pinned) and the local amicissimo vault checkout:
#
#   current            the pinned definitions are unchanged at the vault ref
#   behind-head        a pinned definition changed past the pinned revision
#   fixture-mismatch   a committed fixture no longer matches its record
#   pin-orphaned       the pinned revision left the vault's history
#   vault-absent       this machine cannot see the vault checkout (honest
#                      skip, exit 0 — the fixtures remain the self-contained
#                      pin; only the vault-visible machine can check freshness)
#
# Drift tracking (real runs only): behind-head / fixture-mismatch /
# pin-orphaned → exactly one chore issue in the amicode repo, created on
# first drift (exact title "Role-card parity pin behind the vault (nightly)")
# and updated (commented) on subsequent drifts — searched before creating,
# never duplicated. A gh failure notes issue_update_failed in the receipt and
# does NOT change the exit code. The exact-title search covers OPEN issues
# only: a human-closed tracker is history — the next drift opens a fresh epoch.
#
# Receipt: ONE JSON line per real run appended to the upgrade-receipts
# journal (the doctor's receipt store):
#   {"receipt_version":1,"ts":"…","kind":"role-parity","status":"…",
#    "vault_revision":"…","pinned_revision":"…","drifted_files":[…]
#   [,"tracking_issue":"…"][,"issue_update_failed":true]}
#
# --dry-run: runs the check, prints WOULD-DO lines to stderr, appends NO
# receipt and touches NO issues. This is the testable seam
# (packages/extension/test/ops/role_parity_orchestrator.test.ts).
#
# Configuration (env, defaults documented here):
#   ROLE_PARITY_REPO       ~/armonia/repos/amicode        canonical repo checkout
#   ROLE_PARITY_CHECK      $REPO/packages/extension/scripts/role_parity_check.mts
#   ROLE_PARITY_PIN        $REPO/packages/extension/test/fixtures/vault-agents/pin.json
#   ROLE_PARITY_VAULT      ~/armonia/repos/amicissimo      the vault checkout (read-only)
#   ROLE_PARITY_REF        origin/main                    the vault ref compared against
#   ROLE_PARITY_RECEIPTS   ~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl
#   ROLE_PARITY_TRACKING_REPO  harmoniqs/amicode           where the chore issue lands
#
# Written for /bin/bash (3.2): no associative arrays, no namerefs.
set -uo pipefail

# --- node resolution ---------------------------------------------------------
# The caller's PATH wins (every interactive surface has the fleet's real node);
# the macOS ladder is a FALLBACK for the bare launchd environment, never a
# shadow of a newer node the user's PATH already resolves (the 2026-09-05
# lesson: prepending the ladder on a linux server picked up /usr/bin/node 12
# and every node call died with 'not allowed in NODE_OPTIONS').
if ! command -v node >/dev/null 2>&1; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
fi

SELF_NAME="run-role-parity-check"
ISSUE_TITLE="Role-card parity pin behind the vault (nightly)"

# --- arguments ---------------------------------------------------------------
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) grep '^# ' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "$SELF_NAME: unknown argument: $arg (usage: $0 [--dry-run])" >&2; exit 2 ;;
  esac
done

# --- configuration (defaults per the header table) ---------------------------
AMICODE_REPO="${ROLE_PARITY_REPO:-$HOME/armonia/repos/amicode}"
CHECK="${ROLE_PARITY_CHECK:-$AMICODE_REPO/packages/extension/scripts/role_parity_check.mts}"
PIN="${ROLE_PARITY_PIN:-$AMICODE_REPO/packages/extension/test/fixtures/vault-agents/pin.json}"
VAULT="${ROLE_PARITY_VAULT:-$HOME/armonia/repos/amicissimo}"
REF="${ROLE_PARITY_REF:-origin/main}"
RECEIPTS="${ROLE_PARITY_RECEIPTS:-$HOME/.amico/server/upgrade-receipts/upgrade-receipts.jsonl}"
TRACKING_REPO="${ROLE_PARITY_TRACKING_REPO:-harmoniqs/amicode}"

# --- pre-flight (a broken runtime is not a skippable surface) ----------------
if ! command -v node >/dev/null 2>&1; then
  echo "$SELF_NAME: FATAL node not found on PATH — cannot run the pin check" >&2
  exit 2
fi
# the check CLI is authored TypeScript (.mts): probe the runtime's native
# type-stripping capability and carry the flag when needed (node >= 23 strips
# by default; 22.6+ takes the flag; older node is a named pre-flight fatal,
# never a mystery crash mid-cadence).
NODE_FLAGS=""
if node --experimental-strip-types -e 'process.exit(0)' >/dev/null 2>&1; then
  NODE_FLAGS="--experimental-strip-types"
elif node -e 'const [M,m]=process.versions.node.split(".").map(Number); process.exit(M>=23?0:1)' >/dev/null 2>&1; then
  : # strips natively, no flag needed
else
  echo "$SELF_NAME: FATAL node $(node --version 2>/dev/null) cannot strip TypeScript — the pin check CLI needs node >= 22.6" >&2
  exit 2
fi
if [ ! -f "$CHECK" ]; then
  echo "$SELF_NAME: FATAL pin check CLI not found: $CHECK (set ROLE_PARITY_CHECK)" >&2
  exit 2
fi
if [ ! -f "$PIN" ]; then
  echo "$SELF_NAME: FATAL pin record not found: $PIN (set ROLE_PARITY_PIN)" >&2
  exit 2
fi

# --- the check ----------------------------------------------------------------
TS_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CHECK_JSON="$(node $NODE_FLAGS "$CHECK" --pin "$PIN" --vault "$VAULT" --ref "$REF")" || rc=$?
RC="${rc:-0}"

# the report is ONE JSON line on stdout; parse the fields we need
STATUS="$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(r.status)' "$CHECK_JSON")"
PINNED_REV="$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(r.pinned_revision||"")' "$CHECK_JSON")"
VAULT_REV="$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(r.vault_revision||"")' "$CHECK_JSON")"
DRIFTED_CSV="$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write((r.drifted_files||[]).join(","))' "$CHECK_JSON")"

echo "$SELF_NAME: status=$STATUS pinned=${PINNED_REV:0:12} vault=${VAULT_REV:0:12}${DRIFTED_CSV:+ drifted=$DRIFTED_CSV}" >&2
node -e 'const r=JSON.parse(process.argv[1]);for (const e of r.evidence) console.error("  "+e)' "$CHECK_JSON" >&2

# --- drift escalation: exactly one chore issue, updated never duplicated ------
TRACKING_ISSUE=""
ISSUE_UPDATE_FAILED=0
case "$STATUS" in
  behind-head|fixture-mismatch|pin-orphaned)
    if [ "$DRY_RUN" = "1" ]; then
      echo "$SELF_NAME: WOULD-DO: open-or-update chore issue '$ISSUE_TITLE' in $TRACKING_REPO ($STATUS${DRIFTED_CSV:+ on: $DRIFTED_CSV})" >&2
    else
      BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/$SELF_NAME-body.XXXXXX")"
      {
        echo "The role-card parity pin ($PIN) reports **$STATUS** — run of $TS_ISO."
        echo
        echo '```json'
        echo "$CHECK_JSON"
        echo '```'
        echo
        echo "Re-pin procedure: re-take the fixtures from the current vault revision"
        echo "(copy the definitions, update pin.json's revision + digests) and re-run"
        echo "\`node $CHECK --pin $PIN --vault $VAULT\` until it reads current — or"
        echo "adjudicate the drift first if the definitions changed meaningfully."
      } > "$BODY_FILE"
      # exact-title search (OPEN issues) — one cumulative issue, never
      # duplicated. A human-closed tracker starts a new epoch (closed issues
      # are history, never re-opened, never re-commented).
      found=""
      if gh_list="$(gh issue list -R "$TRACKING_REPO" --state open \
          --search "\"$ISSUE_TITLE\" in:title" --json number,title,url --limit 20 2>/dev/null)"; then
        found="$(node -e '
          let list = [];
          try { list = JSON.parse(process.argv[1] || "[]"); } catch { /* search result lost */ }
          const hit = list.find((it) => it.title === process.argv[2]);
          process.stdout.write(hit ? String(hit.number) : "");
        ' "$gh_list" "$ISSUE_TITLE")"
      fi
      if [ -n "$found" ]; then
        echo "$SELF_NAME: chore issue #$found exists — appending the fresh report" >&2
        if ! gh issue comment "$found" -R "$TRACKING_REPO" --body-file "$BODY_FILE" >&2; then
          echo "$SELF_NAME: WARN gh issue comment failed — receipt notes issue_update_failed" >&2
          ISSUE_UPDATE_FAILED=1
        else
          TRACKING_ISSUE="https://github.com/$TRACKING_REPO/issues/$found"
        fi
      else
        echo "$SELF_NAME: no chore issue found — creating '$ISSUE_TITLE' in $TRACKING_REPO" >&2
        if url="$(gh issue create -R "$TRACKING_REPO" --title "$ISSUE_TITLE" --body-file "$BODY_FILE" 2>/dev/null)"; then
          TRACKING_ISSUE="$url"
          echo "$SELF_NAME: chore issue created → $TRACKING_ISSUE" >&2
        else
          echo "$SELF_NAME: WARN gh issue create failed — receipt notes issue_update_failed" >&2
          ISSUE_UPDATE_FAILED=1
        fi
      fi
      rm -f "$BODY_FILE"
    fi
    ;;
  *)
    if [ "$DRY_RUN" = "1" ]; then
      echo "$SELF_NAME: WOULD-DO: no issue action — status $STATUS (no drift)" >&2
    fi
    ;;
esac

# --- receipt ------------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  echo "$SELF_NAME: DRY-RUN — no receipt appended, no issues touched" >&2
else
  RECEIPT_DIR="$(dirname "$RECEIPTS")"
  mkdir -p "$RECEIPT_DIR" 2>/dev/null
  extra=""
  [ "$ISSUE_UPDATE_FAILED" = "1" ] && extra=',"issue_update_failed":true'
  [ -n "${TRACKING_ISSUE:-}" ] && extra="$extra,\"tracking_issue\":\"$TRACKING_ISSUE\""
  DRIFTED_JSON="[]"
  [ -n "$DRIFTED_CSV" ] && DRIFTED_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1].split(",")))' "$DRIFTED_CSV")"
  echo "{\"receipt_version\":1,\"ts\":\"$TS_ISO\",\"kind\":\"role-parity\",\"status\":\"$STATUS\",\"pinned_revision\":\"$PINNED_REV\",\"vault_revision\":\"$VAULT_REV\",\"drifted_files\":$DRIFTED_JSON$extra}" >> "$RECEIPTS"
fi

exit "$RC"
