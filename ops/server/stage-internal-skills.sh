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
# Second source (2026-09-08, amicissimo #404 / amicode #907): the ENTITLED-TIER
# skills — usage skills for the issmo private packages — are canonical in the
# amicissimo repo's skills/ dir (per its ADR-0002 boundary test: they
# constitute the tuned advantage and ride the entitlement). piccolissimo +
# intonatissimo were previously staging-local hand-copies (the #836 drift
# class); altissimo is new. Staged below with the same allowlist discipline.
#
# Staging-local skills with no canonical home (fleet — personal machine-ops;
# qec-autoresearch — in-flight amicode #368/#390, homed when that lands) are
# hand-managed and NOT touched.
set -euo pipefail

ARMONISSIMA="$HOME/armonia/data/vaults/armonissima/skills"
AMICISSIMO="$HOME/armonia/repos/amicissimo"
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

# --- the entitled tier (amicissimo canonical, #907) ---------------------------
# Same discipline, second source. The amicissimo checkout is fleet-shared and
# routinely parked on campaign branches (its working tree may not carry
# skills/), so the source is EXTRACTED from origin/main via git archive —
# branch-independent, no writes to the shared checkout, fresh via a quiet
# fetch (ref update only, the pnpm-sync --check allowance). Entitled skills
# carry `entitlement: issmo` frontmatter; the server surfaces them only in
# issmo-lit environments.
ENTITLED_ALLOWLIST=(
  piccolissimo
  intonatissimo
  altissimo
)

AMICISSIMO_SRC=""
if [ -d "$AMICISSIMO/.git" ] || git -C "$AMICISSIMO" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$AMICISSIMO" fetch origin --quiet >/dev/null 2>&1 || true
  tmpdir="$(mktemp -d 2>/dev/null || true)"
  if [ -n "$tmpdir" ] && git -C "$AMICISSIMO" archive --format=tar origin/main -- skills 2>/dev/null | tar -x -C "$tmpdir" 2>/dev/null && [ -d "$tmpdir/skills" ]; then
    AMICISSIMO_SRC="$tmpdir/skills"
  else
    [ -n "$tmpdir" ] && rm -rf "$tmpdir"
  fi
fi

if [ -z "$AMICISSIMO_SRC" ]; then
  echo "stage-internal-skills: SKIP entitled tier (no amicissimo clone at $AMICISSIMO or no skills/ on its origin/main)" >&2
else
  for skill in "${ENTITLED_ALLOWLIST[@]}"; do
    src="$AMICISSIMO_SRC/$skill"
    dst="$STAGED/$skill"
    if [ ! -f "$src/SKILL.md" ]; then
      echo "stage-internal-skills: SKIP $skill (absent from amicissimo origin/main — nothing to stage)" >&2
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
  rm -rf "$AMICISSIMO_SRC"
fi

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
