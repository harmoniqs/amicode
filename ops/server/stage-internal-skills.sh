#!/bin/bash
# stage-internal-skills.sh — stage the internal workflow skills from the
# armonissima vault (their canonical home since the amico-plugin retirement,
# 2026-08-05) into the server's staged opencode-project skill set.
#
# Why this exists: amicode-server.sh rsyncs the VSIX's PUBLIC skill set into
# staging (no --delete) — the VSIX never ships internal skills. Until now the
# internal subset was hand-copied, which drifted: implement-issue referenced a
# develop that was never staged, and write-an-issue diverged a full evolution
# (2026-08-16 review). This script makes the staging of that subset
# deliberate: allowlisted skills, per-skill rsync, no delete, loud logging.
#
# Sequencing note: armonissima is canonical BY DECREE — if it regresses, this
# script faithfully stages the regression. Merge pipeline PRs before relying
# on a reboot-driven sync (each stage prints src/dst hashes; check the log).
#
# Staging-local skills with no canonical home (fleet — personal machine-ops;
# qec-autoresearch — in-flight amicode #368/#390, homed when that lands) are
# hand-managed and NOT touched.
set -euo pipefail

ARMONISSIMA="$HOME/armonia/data/vaults/armonissima/skills"
STAGED="$HOME/.amico/server/opencode-project-staging/opencode-project/skills"

ALLOWLIST=(
  director-core
  develop
  implement-issue
  write-an-issue
  break-into-subissues
  bosonic-gkp
  calibrate
  harmony
  shape
  sweep
)

for skill in "${ALLOWLIST[@]}"; do
  src="$ARMONISSIMA/$skill"
  dst="$STAGED/$skill"
  if [ ! -f "$src/SKILL.md" ]; then
    echo "stage-internal-skills: SKIP $skill (absent from armonissima — nothing to stage)" >&2
    continue
  fi
  mkdir -p "$dst"
  before="$(shasum -a 256 "$dst/SKILL.md" 2>/dev/null | awk '{print substr($1,1,12)}' || echo none)"
  rsync -a "$src/" "$dst/"
  after="$(shasum -a 256 "$dst/SKILL.md" | awk '{print substr($1,1,12)}')"
  if [ "$before" = "$after" ]; then
    echo "stage-internal-skills: $skill unchanged ($after)"
  else
    echo "stage-internal-skills: $skill staged $before -> $after"
  fi
done

# --- reference audit (born 2026-08-23: the director-core outage) ---------------
# Every skill mentioned in the armed content that EXISTS in armonissima must
# either be staged above or be a recorded deliberate omission. Intersecting
# with the armonissima universe keeps the scan quiet (real hits only, never
# English false positives). A WARN here is a mode card about to die at runtime.
PROJECT="$(dirname "$STAGED")"
ADVISORY_SKIP=(ingest piccolo-dev)  # mentioned in armed content, deliberately NOT staged

for name in $(grep -rhoE '`[a-z][a-z0-9-]+`' "$STAGED" "$PROJECT/AGENTS.md" "$PROJECT/.opencode/agents" 2>/dev/null | tr -d '`' | sort -u); do
  [ -d "$ARMONISSIMA/$name" ] || continue
  [ -d "$STAGED/$name" ] && continue
  case " ${ADVISORY_SKIP[*]} " in *" $name "*) continue ;; esac
  echo "stage-internal-skills: WARN referenced-but-unstaged: $name (armed content mentions it — add to ALLOWLIST or ADVISORY_SKIP)" >&2
done

# --- staging-path split guard ---------------------------------------------------
# amicode-server.sh stages PUBLIC skills into $WS_DIR (a workspaceStorage dir
# when present, else this script's staging tree). A workspaceStorage dir
# appearing means internals land HERE while publics land THERE — mode-card
# skill references break silently. Loud, not silent.
if ls -d "$HOME/Library/Application Support/Code/User/workspaceStorage/"*/harmoniqs.amicode >/dev/null 2>&1; then
  echo "stage-internal-skills: WARN workspaceStorage harmoniqs.amicode present — public skills may be staging into a DIFFERENT tree than $STAGED" >&2
fi
