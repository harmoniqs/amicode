#!/usr/bin/env bash
# run-skill-freshness.sh — the nightly skill-freshness cadence (amicode#587).
#
# Runs the skill-content drift lint (packages/extension/scripts/
# skill_drift_lint.mts, amicode#586) over THREE skill surfaces on the mini:
#
#   public    the repo's shipped library  packages/extension/skills          structural-only
#   internal  the armonissima vault library  ~/.amico/vaults/armonissima/skills  full
#   staging   the server's staged set  ~/.amico/server/opencode-project-staging/opencode-project/skills  full
#
# The `internal` and `staging` surfaces run the FULL lint (structure + package
# cross-check) against the Julia package checkouts; `public` is structural-only
# (CI's lane — the repo surface has no private deps by design).
#
# Honest degradation: a surface whose directory is absent is reported as
# "skipped" in the receipt — never a crash. The exit code is driven by LINT
# STRUCTURAL FAILURES ONLY (semantic drift alone exits 0; the drift issue owns
# escalation).
#
# Receipt: ONE JSON line per real run appended to the upgrade-receipts journal:
#   {"receipt_version":1,"ts":"…","kind":"skill-freshness",
#    "surfaces":{"public":{ok,verified,drifted,structural}|"skipped",
#                "internal":…,"staging":…}[,"issue_update_failed":true]}
#
# Drift tracking (real runs only): any ran surface with structuralFailures>0
# OR drifted>0 → exactly one tracking issue in the vault repo, created on
# first drift (exact title "Skill freshness report (nightly)") and updated
# (commented) on subsequent drifts — searched before creating, never
# duplicated. A gh failure notes issue_update_failed in the receipt and does
# NOT change the exit code.
#
# --dry-run: writes the per-surface report files and WOULD-DO lines to
# stderr; appends NO receipt and touches NO issues. This is the testable
# seam (packages/extension/test/ops/skill_freshness_orchestrator.test.ts).
#
# Configuration (env, defaults documented here):
#   SKILL_FRESHNESS_REPO      ~/armonia/repos/amicode        canonical repo checkout
#   SKILL_FRESHNESS_LINT      $REPO/packages/extension/scripts/skill_drift_lint.mts
#   SKILL_FRESHNESS_PUBLIC    $REPO/packages/extension/skills
#   SKILL_FRESHNESS_VAULT     ~/.amico/vaults/armonissima/skills
#   SKILL_FRESHNESS_STAGING   ~/.amico/server/opencode-project-staging/opencode-project/skills
#   SKILL_FRESHNESS_PACKAGES  ~/armonia/repos/packages       Julia checkout root
#   SKILL_FRESHNESS_REPORTS   ~/.amico/ops/skill-freshness/reports
#   SKILL_FRESHNESS_RECEIPTS  ~/.amico/server/upgrade-receipts/upgrade-receipts.jsonl
#   SKILL_FRESHNESS_MIN_PUBLIC=20  SKILL_FRESHNESS_MIN_VAULT=50  SKILL_FRESHNESS_MIN_STAGING=45
#   SKILL_FRESHNESS_TRACKING_REPO  harmoniqs/armonissima
#
# Written for macOS /bin/bash (3.2): no associative arrays, no namerefs.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

SELF_NAME="run-skill-freshness"

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
AMICODE_REPO="${SKILL_FRESHNESS_REPO:-$HOME/armonia/repos/amicode}"
LINT="${SKILL_FRESHNESS_LINT:-$AMICODE_REPO/packages/extension/scripts/skill_drift_lint.mts}"
PUBLIC_DIR="${SKILL_FRESHNESS_PUBLIC:-$AMICODE_REPO/packages/extension/skills}"
VAULT_DIR="${SKILL_FRESHNESS_VAULT:-$HOME/.amico/vaults/armonissima/skills}"
STAGING_DIR="${SKILL_FRESHNESS_STAGING:-$HOME/.amico/server/opencode-project-staging/opencode-project/skills}"
PACKAGES_DIR="${SKILL_FRESHNESS_PACKAGES:-$HOME/armonia/repos/packages}"
REPORTS_DIR="${SKILL_FRESHNESS_REPORTS:-$HOME/.amico/ops/skill-freshness/reports}"
RECEIPTS="${SKILL_FRESHNESS_RECEIPTS:-$HOME/.amico/server/upgrade-receipts/upgrade-receipts.jsonl}"
MIN_PUBLIC="${SKILL_FRESHNESS_MIN_PUBLIC:-20}"
MIN_VAULT="${SKILL_FRESHNESS_MIN_VAULT:-50}"
MIN_STAGING="${SKILL_FRESHNESS_MIN_STAGING:-45}"
TRACKING_REPO="${SKILL_FRESHNESS_TRACKING_REPO:-harmoniqs/armonissima}"
ISSUE_TITLE="Skill freshness report (nightly)"

# --- pre-flight (a broken runtime is not a skippable surface) ----------------
if ! command -v node >/dev/null 2>&1; then
  echo "$SELF_NAME: FATAL node not found on PATH — cannot run the lint CLI" >&2
  exit 1
fi
if [ ! -f "$LINT" ]; then
  echo "$SELF_NAME: FATAL lint CLI not found: $LINT (set SKILL_FRESHNESS_LINT)" >&2
  exit 1
fi

TS_ISO="$(date -u +%FT%TZ)"
TS_FILE="${TS_ISO//[-:]/}"

# Surface state, parallel indexed arrays (bash 3.2). Indices are fixed:
# 0=public 1=internal 2=staging — the receipt depends on this order.
KEYS=(public internal staging)
FRAGS=()      # receipt fragment per surface: {...} or "skipped"
DRIFTS=()     # 1 when the surface counts toward the drift condition
STRUCTS=()    # 1 when the surface had structural failures
RANS=()       # 1 when the surface ran (dir present)

# counts <report-file> — emit the receipt fragment for a ran surface.
# A missing/unparseable report (lint died before writing) counts as a
# structural failure: the surface ran and produced no clean evidence.
counts() {
  node -e '
    const fs = require("node:fs");
    let r = null;
    try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { /* report lost */ }
    if (!r) {
      process.stdout.write("{\"ok\":false,\"verified\":0,\"drifted\":0,\"structural\":1}");
      process.exit(0);
    }
    const a = r.aggregate || {};
    process.stdout.write(JSON.stringify({
      ok: r.ok === true && (a.structuralFailures || 0) === 0,
      verified: a.verified || 0,
      drifted: a.drifted || 0,
      structural: a.structuralFailures || 0,
    }));
  ' "$1"
}

# run_surface <key> <dir> <min> <structural-only|full>
# Sets globals: FRAG, DRIFTED_SURFACE, STRUCTURAL_HIT.
FRAG="\"skipped\""
DRIFTED_SURFACE=0
STRUCTURAL_HIT=0
run_surface() {
  FRAG="\"skipped\""; DRIFTED_SURFACE=0; STRUCTURAL_HIT=0
  local key="$1" dir="$2" min="$3" mode="$4"
  if [ ! -d "$dir" ]; then
    echo "$SELF_NAME: SKIP $key surface — skills dir not found: $dir" >&2
    return 0
  fi
  local report="$REPORTS_DIR/$TS_FILE-$key.json"
  local -a args=(--skills "$dir" --min-skills "$min" --report json --out "$report")
  if [ "$mode" = "full" ]; then
    if [ ! -d "$PACKAGES_DIR" ]; then
      echo "$SELF_NAME: NOTE $key surface — packages root not found: $PACKAGES_DIR (claims will be UNVERIFIABLE, not drift)" >&2
    fi
    args+=(--packages "$PACKAGES_DIR")
  else
    args+=(--structural-only)
  fi
  mkdir -p "$REPORTS_DIR"
  local rc=0
  node "$LINT" "${args[@]}" >&2 || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "$SELF_NAME: lint $key surface exited $rc (1=structural, 2=usage/pre-flight)" >&2
  fi
  FRAG="$(counts "$report")"
  if node -e 'const f=JSON.parse(process.argv[1]);process.exit((f.structural>0||f.drifted>0)?0:1)' "$FRAG" 2>/dev/null; then
    DRIFTED_SURFACE=1
  fi
  if node -e 'const f=JSON.parse(process.argv[1]);process.exit(f.structural>0?0:1)' "$FRAG" 2>/dev/null; then
    STRUCTURAL_HIT=1
  fi
  return 0
}

# --- run the three surfaces ---------------------------------------------------
SPECS=("public|$PUBLIC_DIR|$MIN_PUBLIC|structural" \
       "internal|$VAULT_DIR|$MIN_VAULT|full" \
       "staging|$STAGING_DIR|$MIN_STAGING|full")
i=0
for spec in "${SPECS[@]}"; do
  IFS='|' read -r skey sdir smin smode <<< "$spec"
  run_surface "$skey" "$sdir" "$smin" "$smode"
  FRAGS[$i]="$FRAG"; DRIFTS[$i]="$DRIFTED_SURFACE"; STRUCTS[$i]="$STRUCTURAL_HIT"
  if [ "$FRAG" = '"skipped"' ]; then RANS[$i]=0; else RANS[$i]=1; fi
  i=$((i + 1))
done

# --- per-surface verdict lines (stderr; the launchd log / test surface) -------
i=0
for key in "${KEYS[@]}"; do
  echo "$SELF_NAME: surface $key → ${FRAGS[$i]}"
  i=$((i + 1))
done

# --- drift condition over ran surfaces -----------------------------------------
DRIFT_KEYS=()
STRUCT_EXIT=0
i=0
for key in "${KEYS[@]}"; do
  if [ "${RANS[$i]}" = "1" ]; then
    if [ "${STRUCTS[$i]}" = "1" ]; then STRUCT_EXIT=1; fi
    if [ "${DRIFTS[$i]}" = "1" ]; then DRIFT_KEYS+=("$key"); fi
  fi
  i=$((i + 1))
done

# --- issue body builder (shared by create/comment) -------------------------------
build_issue_body() {
  # args: surface=report-path pairs; prints markdown to stdout
  node -e '
    const fs = require("node:fs");
    const pairs = process.argv.slice(1);
    const rows = []; const tops = []; const structs = []; const jsons = [];
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      const key = pair.slice(0, eq);
      const file = pair.slice(eq + 1);
      let r = null;
      try { r = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* report lost */ }
      if (!r) { rows.push("| " + key + " | ❌ report lost | — | — | — | 1 |"); continue; }
      const a = r.aggregate || {};
      rows.push("| " + key + " | " + (r.ok ? "✅" : "❌") + " | " + (a.skills ?? "—") + " | " +
        (a.verified ?? "—") + " | " + (a.drifted ?? "—") + " | " + (a.structuralFailures ?? "—") + " |");
      // top drifted skills: per-skill DRIFTED claim counts, descending
      const driftedSkills = (r.skills || [])
        .map((s) => ({ name: s.skill, n: (s.claims || []).filter((c) => c.verdict === "DRIFTED").length }))
        .filter((s) => s.n > 0)
        .sort((x, y) => y.n - x.n).slice(0, 5);
      for (const s of driftedSkills) tops.push("- `" + s.name + "` — " + s.n + " drifted claim(s)");
      // structural failures: report-level first, then per-skill (capped)
      for (const f of r.topStructural || []) structs.push("- (report) " + f.message);
      for (const s of r.skills || []) for (const f of (s.structural || []).slice(0, 3))
        structs.push("- `" + s.skill + "`" + (f.line ? ":" + f.line : "") + " " + f.message);
      jsons.push(JSON.stringify({ surface: key, report: r }, null, 2));
    }
    let out = "Nightly skill-freshness cadence run — mechanical verdicts from the #586 lint (no LLM judgment).\n\n";
    out += "| surface | ok | skills | verified | drifted | structural |\n|---|---|---|---|---|---|\n";
    out += rows.join("\n") + "\n";
    if (tops.length) out += "\n**Top drifted skills**\n" + tops.join("\n") + "\n";
    if (structs.length) out += "\n**Structural failures** (first 10)\n" + structs.slice(0, 10).join("\n") + "\n";
    out += "\n<details><summary>Full lint JSON reports</summary>\n\n```json\n" + jsons.join("\n\n") + "\n```\n\n</details>\n";
    process.stdout.write(out);
  ' "$@"
}

# --- receipt (real runs only; dry-run never touches the journal) ----------------
append_receipt() {
  local extra="$1"  # "" or ,"issue_update_failed":true
  local line="{\"receipt_version\":1,\"ts\":\"$TS_ISO\",\"kind\":\"skill-freshness\",\"surfaces\":{\"public\":${FRAGS[0]},\"internal\":${FRAGS[1]},\"staging\":${FRAGS[2]}}$extra}"
  mkdir -p "$(dirname "$RECEIPTS")"
  printf '%s\n' "$line" >> "$RECEIPTS"
  echo "$SELF_NAME: receipt appended → $RECEIPTS" >&2
}

# --- drift escalation: exactly one tracking issue, updated never duplicated ----
ISSUE_UPDATE_FAILED=0
if [ "${#DRIFT_KEYS[@]}" -gt 0 ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "$SELF_NAME: WOULD-DO: open-or-update tracking issue '$ISSUE_TITLE' in $TRACKING_REPO (drift on: ${DRIFT_KEYS[*]})" >&2
  else
    body_args=()
    i=0
    for key in "${KEYS[@]}"; do
      if [ "${RANS[$i]}" = "1" ]; then body_args+=("$key=$REPORTS_DIR/$TS_FILE-$key.json"); fi
      i=$((i + 1))
    done
    body_file="$(mktemp "${TMPDIR:-/tmp}/$SELF_NAME-body.XXXXXX")"
    {
      echo "Drift detected on surfaces: ${DRIFT_KEYS[*]}. Run of $TS_ISO:"
      echo
      build_issue_body "${body_args[@]}"
    } > "$body_file"
    # exact-title search (any state) — one cumulative issue, never duplicated
    found=""
    if gh_list="$(gh issue list -R "$TRACKING_REPO" --state all \
        --search "\"$ISSUE_TITLE\" in:title" --json number,title,url --limit 20 2>/dev/null)"; then
      found="$(node -e '
        let list = [];
        try { list = JSON.parse(process.argv[1] || "[]"); } catch { /* search result lost */ }
        const hit = list.find((it) => it.title === process.argv[2]);
        process.stdout.write(hit ? String(hit.number) : "");
      ' "$gh_list" "$ISSUE_TITLE")"
    fi
    if [ -n "$found" ]; then
      echo "$SELF_NAME: tracking issue #$found exists — appending the fresh report" >&2
      if ! gh issue comment "$found" -R "$TRACKING_REPO" --body-file "$body_file" >&2; then
        echo "$SELF_NAME: WARN gh issue comment failed — receipt notes issue_update_failed" >&2
        ISSUE_UPDATE_FAILED=1
      fi
    else
      echo "$SELF_NAME: no tracking issue found — creating '$ISSUE_TITLE' in $TRACKING_REPO" >&2
      if ! gh issue create -R "$TRACKING_REPO" --title "$ISSUE_TITLE" --body-file "$body_file" >&2; then
        echo "$SELF_NAME: WARN gh issue create failed — receipt notes issue_update_failed" >&2
        ISSUE_UPDATE_FAILED=1
      fi
    fi
    rm -f "$body_file"
  fi
elif [ "$DRY_RUN" = "1" ]; then
  echo "$SELF_NAME: WOULD-DO: no issue action — no drift on ran surfaces" >&2
fi

# --- receipt -------------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  echo "$SELF_NAME: DRY-RUN — no receipt appended, no issues touched" >&2
else
  extra=""
  [ "$ISSUE_UPDATE_FAILED" = "1" ] && extra=',"issue_update_failed":true'
  append_receipt "$extra"
fi

exit "$STRUCT_EXIT"
