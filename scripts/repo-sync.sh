#!/usr/bin/env bash
# repo-sync — one-command sync for the amicode fleet repo + vendored fork.
# Idempotent: safe to run on a clean tree, shows drift without touching it in --check.
#
#   pnpm sync                # amicode repo: git fetch, pnpm, vendor, fleet (no writes beyond fetch/install)
#   pnpm sync --fix          # also writes: git pull --ff-only, pnpm install, fetch:opencode, fleet install
#   pnpm sync --fork         # opencode fork: show clone status, build/pin help
#   bash scripts/repo-sync.sh --check  # CI twin: no writes, exit 1 on drift
#
# Machine-scoped fleet settings (guard/tunnel) are never auto-mutated here —
# use `bash tools/fleet/install.sh` (or VS Code `Fleet — Repair`) for that.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHECK=0
FIX=0
FORK=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --fix) FIX=1 ;;
    --fork) FORK=1 ;;
    -h|--help) sed -n '1,80p' "$0"; exit 0 ;;
    *) echo "unknown flag $a (try --help)" >&2; exit 2 ;;
  esac
done

# In --check, --fix is not implied (CI wants check only).
# Plain `pnpm sync` is check-only + fetch (read-only). `pnpm sync --fix` mutates.

say() { printf '\033[1;35m[repo-sync]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[repo-sync] FAIL %s\033[0m\n' "$*" >&2; }
ok() { printf '\033[1;32m[repo-sync] ok %s\033[0m\n' "$*"; }

# --- fork mode: just report clone status + build/pin help ---
if [[ $FORK -eq 1 ]]; then
  CLONE="${AMICODE_OPENCODE_SRC:-$ROOT/../opencode}"
  say "fork clone: $CLONE"
  if [[ ! -d "$CLONE/.git" ]]; then
    fail "no clone at $CLONE — git clone git@github.com:harmoniqs/opencode.git $CLONE && curl -fsSL https://bun.sh/install | bash"
    exit 1
  fi
  say "branch: $(git -C "$CLONE" symbolic-ref --short HEAD 2>/dev/null || git -C "$CLONE" rev-parse --short HEAD)"
  say "status: $(git -C "$CLONE" status --porcelain | wc -l | tr -d ' ') dirty files"
  say "lock: $(cat "$ROOT/packages/extension/opencode.lock.json" | python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(f\"{d.get('tag')} @ {d.get('ref','')[:7]} source={d.get('source')}\")" "$ROOT/packages/extension/opencode.lock.json" 2>&1 || echo "read error")"
  say "vendor: $(cat "$ROOT/packages/extension/vendor/opencode/darwin-arm64/.source" 2>/dev/null || echo "missing")"
  echo ""
  echo "  pnpm --filter amicode opencode:build   # rebuild from $CLONE (OPENCODE_CHANNEL=dev, --any-ref)"
  echo "  pnpm --filter amicode opencode:pin <tag>  # pin a cut release (e.g. v1.18.10-amicode.5)"
  echo "  bash packages/extension/scripts/assert_ui_gate.sh vendor/opencode/darwin-arm64/opencode"
  exit 0
fi

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
  if [[ -n "$(git status --porcelain 2>&1)" ]]; then fail "working tree dirty — git status --short:"; git status --short 2>&1 | head -n 20; EXIT=1; else ok "working tree clean"; fi
else
  say "no upstream for $BRANCH (skip behind check)"
fi

# 2. gh auth + private fork access (needed for fetch:opencode release path)
if command -v gh >/dev/null 2>&1; then
  if gh auth status 2>&1 | grep -q "Logged in"; then ok "gh auth logged in"
  else fail "gh auth not logged in — gh auth login"; EXIT=1; fi
  if gh repo view harmoniqs/opencode --json name 2>&1 | grep -q "opencode"; then ok "gh can view harmoniqs/opencode"
  else fail "gh cannot view harmoniqs/opencode (private fork, need access from Aaron)"; EXIT=1; fi
else
  fail "gh CLI not on PATH — needed for private fork fetch"; EXIT=1
fi

# 3. node / pnpm / bun
if command -v node >/dev/null 2>&1; then ok "node $(node --version)"; else fail "node not found (>=20)"; EXIT=1; fi
if command -v pnpm >/dev/null 2>&1 || corepack pnpm --version >/dev/null 2>&1; then ok "pnpm $(pnpm --version 2>&1 | head -n1 || corepack pnpm --version 2>&1 | head -n1)"; else fail "pnpm not found (corepack enable)"; EXIT=1; fi
if [[ -d "$ROOT/../opencode/.git" ]] && ! command -v bun >/dev/null 2>&1; then fail "bun not found (needed only when changing the fork: curl -fsSL https://bun.sh/install | bash)"; fi

# 4. pnpm install (check vs fix)
if [[ $CHECK -eq 1 ]]; then
  if pnpm install --frozen-lockfile --dry-run 2>&1 | grep -q "ERR"; then fail "pnpm install --frozen-lockfile would change lockfile"; EXIT=1; else ok "pnpm lockfile in sync (dry-run)"; fi
else
  say "pnpm install (may take a minute)"
  if pnpm install 2>&1 | tail -n 20; then ok "pnpm install"; else fail "pnpm install failed"; EXIT=1; fi
fi

# 5. vendor vs lock
say "vendor vs lock"
if [[ $FIX -eq 1 ]]; then
  # --fix: actually fetch the pinned binary so `pnpm test` + `vsce` see the right one, plus full gates
  if pnpm --filter amicode run fetch:opencode 2>&1 | tail -n 5; then ok "fetch:opencode (pinned, features-ON)"; else fail "fetch:opencode"; EXIT=1; fi
  if bash packages/extension/scripts/assert_ui_gate.sh "packages/extension/vendor/opencode/darwin-arm64/opencode" 2>&1 | tail -n 5; then ok "ui gate ON (dev channel)"; else fail "ui gate (binary hides amicode UI — rebuild with OPENCODE_CHANNEL=dev)"; EXIT=1; fi
  if bash packages/extension/scripts/assert_fleet_guard.sh 2>&1 | tail -n 5; then ok "fleet gate"; else fail "fleet gate"; EXIT=1; fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if bash tools/fleet/install.sh --check 2>&1 | tail -n 10; then ok "fleet install (darwin, guard+tunnel+settings)"; else fail "fleet install --check (run: bash tools/fleet/install.sh)"; EXIT=1; fi
  else
    ok "fleet install skipped (not darwin)"
  fi
elif [[ $CHECK -eq 1 ]]; then
  # --check: just validate templates, don't network (CI twin)
  if bash packages/extension/scripts/assert_fleet_guard.sh 2>&1 | tail -n 5; then ok "fleet gate (repo)"; else fail "fleet gate"; EXIT=1; fi
else
  # default (no flag): fetch + gates (no build/test) — useful for `pnpm sync` without --fix
  if pnpm --filter amicode run fetch:opencode 2>&1 | tail -n 5; then ok "fetch:opencode (pinned, features-ON)"; else fail "fetch:opencode"; EXIT=1; fi
  if bash packages/extension/scripts/assert_ui_gate.sh "packages/extension/vendor/opencode/darwin-arm64/opencode" 2>&1 | tail -n 5; then ok "ui gate ON (dev channel)"; else fail "ui gate"; EXIT=1; fi
  if bash packages/extension/scripts/assert_fleet_guard.sh 2>&1 | tail -n 5; then ok "fleet gate"; else fail "fleet gate"; EXIT=1; fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if bash tools/fleet/install.sh --check 2>&1 | tail -n 10; then ok "fleet install (darwin)"; else fail "fleet install --check"; EXIT=1; fi
  else
    ok "fleet install skipped (not darwin)"
  fi
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
