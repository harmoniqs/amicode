#!/usr/bin/env bash
# repo-sync — one-command sync for the amicode fleet repo + vendored binary.
# Idempotent: safe to run on a clean tree, shows drift without touching it in --check.
#
#   pnpm sync                # amicode repo: git fetch, pnpm, vendor, fleet (no writes beyond fetch/install)
#   pnpm sync --fix          # also writes: git pull --ff-only, pnpm install, fetch:opencode, fleet install
#   bash scripts/repo-sync.sh --check  # CI twin: no writes, exit 1 on drift
#
# Machine-scoped fleet settings (guard/tunnel) are never auto-mutated here —
# use `bash tools/fleet/install.sh` (or VS Code `Fleet — Repair`) for that.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHECK=0
FIX=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --fix) FIX=1 ;;
    --fork) echo "The --fork mode is retired. The opencode fork is archived; binary builds use the overlay tree now (pnpm run build:binary)." >&2; exit 2 ;;
    -h|--help) sed -n '1,80p' "$0"; exit 0 ;;
    *) echo "unknown flag $a (try --help)" >&2; exit 2 ;;
  esac
done

# In --check, --fix is not implied (CI wants check only).
# Plain `pnpm sync` is check-only + fetch (read-only). `pnpm sync --fix` mutates.

say() { printf '\033[1;35m[repo-sync]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[repo-sync] FAIL %s\033[0m\n' "$*" >&2; }
ok() { printf '\033[1;32m[repo-sync] ok %s\033[0m\n' "$*"; }

EXIT=0

# 1. git fetch + behind check
say "git fetch --prune"
if ! git fetch --prune --all 2>&1 | head -n 20; then fail "git fetch failed (offline?)"; EXIT=1; fi
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD)"
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "")"
if [[ -n "$UPSTREAM" ]]; then
  BEHIND="$(git rev-list --count HEAD.."$UPSTREAM" 2>/dev/null || echo "?")"
  AHEAD="$(git rev-list --count "$UPSTREAM"..HEAD 2>/dev/null || echo "?")"
  if [[ "$BEHIND" != "0" && "$BEHIND" != "?" ]]; then
    fail "branch $BRANCH behind $UPSTREAM by $BEHIND — git pull --ff-only"
    if [[ $FIX -eq 1 ]]; then
      say "fix: git pull --ff-only"
      if git pull --ff-only 2>&1 | head -n 20; then ok "pulled"; else fail "pull failed (diverged?)"; EXIT=1; fi
    else
      EXIT=1
    fi
  else
    ok "git $BRANCH up to date with $UPSTREAM (ahead $AHEAD)"
  fi
  if ! git diff --quiet 2>&1; then fail "working tree dirty — git status --short:"; git status --short 2>&1 | head -n 20; EXIT=1; else ok "working tree clean"; fi
else
  say "no upstream for $BRANCH (skip behind check)"
fi

# 2. gh auth (needed for upstream staleness checks)
if command -v gh >/dev/null 2>&1; then
  if gh auth status 2>&1 | grep -q "Logged in"; then ok "gh auth logged in"
  else fail "gh auth not logged in — gh auth login"; EXIT=1; fi
else
  fail "gh CLI not on PATH"; EXIT=1
fi

# 2b. overlay health: the app-bundle manifest must exist
if [[ -f "$ROOT/packages/app-bundle/manifest.json" ]]; then
  OVERLAY_VER="$(node -p "JSON.parse(require('fs').readFileSync('$ROOT/packages/app-bundle/manifest.json','utf8')).overlay_sha || 'unknown'" 2>/dev/null || echo "unknown")"
  ok "overlay manifest present (base sha ${OVERLAY_VER:0:12})"
else
  fail "overlay manifest missing (packages/app-bundle/manifest.json) — run pnpm --filter @amicode/app-bundle sync:apply"
  EXIT=1
fi

# 3. node / pnpm / bun (bun is required for local binary builds via build:binary)
if command -v node >/dev/null 2>&1; then ok "node $(node --version)"; else fail "node not found (>=20)"; EXIT=1; fi
if command -v pnpm >/dev/null 2>&1 || corepack pnpm --version >/dev/null 2>&1; then ok "pnpm $(pnpm --version 2>&1 | head -n1 || corepack pnpm --version 2>&1 | head -n1)"; else fail "pnpm not found (corepack enable)"; EXIT=1; fi
if command -v bun >/dev/null 2>&1; then ok "bun $(bun --version 2>&1 | head -n1)"; else say "bun not found (required for build:binary: curl -fsSL https://bun.sh/install | bash)"; fi

# 4. pnpm install (check vs fix)
if [[ $CHECK -eq 1 ]]; then
  if pnpm install --frozen-lockfile --dry-run 2>&1 | grep -q "ERR"; then fail "pnpm install --frozen-lockfile would change lockfile"; EXIT=1; else ok "pnpm lockfile in sync (dry-run)"; fi
else
  say "pnpm install (may take a minute)"
  if pnpm install 2>&1 | tail -n 20; then ok "pnpm install"; else fail "pnpm install failed"; EXIT=1; fi
fi

# 5. vendor vs lock
say "vendor vs lock"
if [[ $FIX -eq 1 || $CHECK -eq 0 ]]; then
  # In default (no --check) and --fix, actually fetch the pinned binary so `pnpm test` + `vsce` see the right one.
  # On --check CI, don't fetch (network), just assert the repo template is sane.
  if [[ $CHECK -eq 1 ]]; then
    if bash packages/extension/scripts/assert_fleet_guard.sh 2>&1 | tail -n 5; then ok "fleet gate (repo template)"; else fail "fleet gate"; EXIT=1; fi
  else
    if pnpm --filter amicode run fetch:opencode 2>&1 | tail -n 5; then ok "fetch:opencode (pinned, features-ON)"; else fail "fetch:opencode"; EXIT=1; fi
    if bash packages/extension/scripts/assert_ui_gate.sh "packages/extension/vendor/opencode/darwin-arm64/opencode" 2>&1 | tail -n 5; then ok "ui gate ON (dev channel)"; else fail "ui gate (binary hides amicode UI — rebuild with OPENCODE_CHANNEL=dev)"; EXIT=1; fi
    if bash packages/extension/scripts/assert_fleet_guard.sh 2>&1 | tail -n 5; then ok "fleet gate"; else fail "fleet gate"; EXIT=1; fi
    if [[ "$(uname -s)" == "Darwin" ]]; then
      if bash tools/fleet/install.sh --check 2>&1 | tail -n 10; then ok "fleet install (darwin, guard+tunnel+settings)"; else fail "fleet install --check (run: bash tools/fleet/install.sh)"; EXIT=1; fi
    else
      ok "fleet install skipped (not darwin)"
    fi
  fi
else
  # --check only: just validate templates, don't network
  if bash packages/extension/scripts/assert_fleet_guard.sh 2>&1 | tail -n 5; then ok "fleet gate (repo)"; else fail "fleet gate"; EXIT=1; fi
fi

# 6. build + tests (only in --fix or default with network? keep check light)
if [[ $FIX -eq 1 ]]; then
  say "pnpm -r build"
  if pnpm -r build 2>&1 | tail -n 20; then ok "build"; else fail "build"; EXIT=1; fi
  say "pnpm -r test (fast)"
  if pnpm --filter amicode test 2>&1 | tail -n 20; then ok "test fast"; else fail "test fast"; EXIT=1; fi
else
  say "skip build/test in check mode (run pnpm sync --fix for full gate)"
fi

if [[ $EXIT -eq 0 ]]; then
  ok "repo-sync all ok"
else
  fail "repo-sync found drift — see FAIL lines above. Fix: pnpm sync --fix (or bash scripts/repo-sync.sh --fix)"
fi
exit $EXIT
