#!/usr/bin/env bash
# Smoke test for scripts/armonia-init (--no-github mode).
# Builds a throwaway template dir, runs armonia-init against a temp vaults ROOT,
# and asserts: dest created, kind marker correct, idempotency (2nd run exits 64).
# No network / no GitHub.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INIT="$HERE/../scripts/armonia-init"
[ -x "$INIT" ] || { echo "FAIL: $INIT not executable"; exit 1; }

fail() { echo "FAIL: $*"; exit 1; }

# --- fixtures ---
TMPL="$(mktemp -d)"        # throwaway template (plain dir, NOT a git repo)
ROOT="$(mktemp -d)"        # vaults root, reused for both invocations
trap 'rm -rf "$TMPL" "$ROOT"' EXIT

# minimal template skeleton
for d in hopper specs plans notes briefs scripts systemd; do
  mkdir -p "$TMPL/$d"; touch "$TMPL/$d/.gitkeep"
done
printf 'kind = "personal"\nname = "armonia-template"\n' > "$TMPL/.amico-vault.toml"
printf '#!/usr/bin/env bash\ntrue\n' > "$TMPL/scripts/armonia-sync-once"
chmod +x "$TMPL/scripts/armonia-sync-once"

export AMICO_TEMPLATE_PATH="$TMPL"
export AMICO_NO_TIMER=1     # never touch systemd from the test

# --- first invocation: should succeed ---
if ! "$INIT" jane-doe --no-github --root "$ROOT"; then
  fail "first armonia-init invocation did not exit 0"
fi

DEST="$ROOT/armonia-jane-doe"
[ -d "$DEST" ] || fail "dest $DEST was not created"
[ -d "$DEST/.git" ] || fail "dest is not a git repo"

# marker must say kind = "personal"
grep -q '^kind = "personal"$' "$DEST/.amico-vault.toml" \
  || fail "marker kind is not personal: $(cat "$DEST/.amico-vault.toml")"
# marker name must be the repo name
grep -q '^name = "armonia-jane-doe"$' "$DEST/.amico-vault.toml" \
  || fail "marker name is wrong: $(cat "$DEST/.amico-vault.toml")"

# --- second invocation against the SAME root: must exit 64 (already exists) ---
set +e
"$INIT" jane-doe --no-github --root "$ROOT" 2>/dev/null
rc=$?
set -e
[ "$rc" -eq 64 ] || fail "second invocation should exit 64, got $rc"

echo "PASS: armonia-init smoke test (create + marker + idempotency-exit-64)"
