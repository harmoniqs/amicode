#!/usr/bin/env bash
# Smoke test for scripts/armonia-init (--no-github mode).
# Builds a throwaway template dir, runs armonia-init against a temp vaults ROOT,
# and asserts: dest created, kind marker correct, minted-name lint (the naming
# rule), override stamping, template rule-section presence, the sweep note,
# and re-run semantics (2nd run exits 64 against a fully-provisioned vault).
# No network / no GitHub.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INIT="$HERE/../scripts/armonia-init"
REPO="$HERE/.."
[ -x "$INIT" ] || { echo "FAIL: $INIT not executable"; exit 1; }

fail() { echo "FAIL: $*"; exit 1; }

# --- fixtures ---
TMPL="$(mktemp -d)"        # throwaway template (plain dir, NOT a git repo)
ROOT="$(mktemp -d)"        # vaults root, reused for all invocations
trap 'rm -rf "$TMPL" "$ROOT"' EXIT

# minimal template skeleton
for d in hopper specs plans notes briefs scripts systemd; do
  mkdir -p "$TMPL/$d"; touch "$TMPL/$d/.gitkeep"
done
printf 'kind = "personal"\nname = "armonia-template"\n' > "$TMPL/.amico-vault.toml"
printf '#!/usr/bin/env bash\ntrue\n' > "$TMPL/scripts/armonia-sync-once"
chmod +x "$TMPL/scripts/armonia-sync-once"
printf '# amico-sync-cadence: 15m\n[Unit]\nDescription=cadence-fixture\n' > "$TMPL/systemd/armonia-sync.timer"

export AMICO_TEMPLATE_PATH="$TMPL"
export AMICO_NO_TIMER=1     # never touch systemd from the test

# --- first invocation: should succeed ---
if ! "$INIT" jane-doe --no-github --root "$ROOT"; then
  fail "first armonia-init invocation did not exit 0"
fi

DEST="$ROOT/vault-jane-doe"
[ -d "$DEST" ] || fail "dest $DEST was not created"
[ -d "$DEST/.git" ] || fail "dest is not a git repo"

# marker must say kind = "personal"
grep -q '^kind = "personal"$' "$DEST/.amico-vault.toml" \
  || fail "marker kind is not personal: $(cat "$DEST/.amico-vault.toml")"
# marker name must be the MINTED vault- name (naming rule: vault-<owner-or-purpose>)
grep -q '^name = "vault-jane-doe"$' "$DEST/.amico-vault.toml" \
  || fail "marker name is wrong (minted name must be vault-<name>): $(cat "$DEST/.amico-vault.toml")"

# --- naming-rule lint: containment, both positions ---
set +e
"$INIT" armonia-foo --no-github --root "$ROOT" 2>"$ROOT/.lint1"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "lint must refuse NAME=armonia-foo (embedded 'armonia')"
grep -qi 'names the workspace' "$ROOT/.lint1" \
  || fail "refusal must print the rule text; got: $(cat "$ROOT/.lint1")"
[ -d "$ROOT/vault-armonia-foo" ] && fail "lint refusal must not create the vault"

set +e
"$INIT" jane-armonia-doe --no-github --root "$ROOT" 2>"$ROOT/.lint2"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "lint must refuse a suffix-position 'armonia' (containment, not prefix)"

# --- override: proceeds AND stamps the sanctioned-exception note ---
"$INIT" armonia-legacy --override --no-github --root "$ROOT" >/dev/null 2>&1 \
  || fail "override must proceed past the lint"
OD="$ROOT/vault-armonia-legacy"
[ -f "$OD/README.md" ] || fail "override vault must carry a README (the stamp target)"
grep -qi 'sanctioned exception' "$OD/README.md" \
  || fail "override README must carry the sanctioned-exception note"
if grep -qi 'deviation' "$OD/README.md"; then
  fail "override note must NEVER use the word 'deviation' (sanctioned, not deviation)"
fi

# --- the template's delimited rule section (the generated surface) ---
TPLREADME="$REPO/scratchpad/armonia-template-staging/README.md"
[ -f "$TPLREADME" ] || fail "template README missing: $TPLREADME"
grep -q '^## Naming & layout (the rule of record)$' "$TPLREADME" \
  || fail "template README must carry the delimited rule section heading"
grep -q 'vault-<owner-or-purpose>' "$TPLREADME" \
  || fail "template rule section must state the minted-name form"

# --- the sweep note (one-time, lists every fleet vault) ---
SWEEP="$REPO/docs/vault-naming-sweep.md"
[ -f "$SWEEP" ] || fail "sweep note missing: $SWEEP"
for vault in vault-aaron vault-partitura armonissima meeting-vault vault-attic vault-public vault-visionroom; do
  grep -q "$vault" "$SWEEP" || fail "sweep note must list fleet vault: $vault"
done

# --- second invocation against the SAME fully-provisioned vault: exit 64 ---
set +e
"$INIT" jane-doe --no-github --root "$ROOT" 2>/dev/null
rc=$?
set -e
[ "$rc" -eq 64 ] || fail "second invocation should exit 64 (already exists), got $rc"

# ══════════════════════════════════════════════════════════════════════════
# Slice B: the day-1 provisioning contract (root states, degraded path,
# idempotent resume, cadence). Test seams (network-free by design):
#   AMICO_CANONICAL_VAULTS_DATA — canonical storage target for the contract
#   AMICO_RESUME_REMOTE         — remote URL seam for the resume step
#   a gh shim on PATH            — records invocations, never hits GitHub
# ══════════════════════════════════════════════════════════════════════════

SB="$(mktemp -d)"; CANON="$SB/canonical"
export AMICO_CANONICAL_VAULTS_DATA="$CANON"
export AMICO_ENFORCE_ROOT_CONTRACT=1

# — root-state: ABSENT root → created + symlinked to the canonical target —
"$INIT" abigail --no-github --root "$SB/roots/absent" >/dev/null 2>&1 \
  || fail "absent root: init must create it (canonical + symlink)"
[ -L "$SB/roots/absent" ] || fail "absent root must become a symlink to the canonical target"
[ -d "$CANON/vault-abigail" ] || fail "absent root: vault must live under the canonical target"

# — root-state: EMPTY real dir → adopted (rmdir + symlink) —
mkdir -p "$SB/roots/empty"
"$INIT" barbara --no-github --root "$SB/roots/empty" >/dev/null 2>&1 \
  || fail "empty real dir: init must adopt the doctrine"
[ -L "$SB/roots/empty" ] || fail "empty real dir must be replaced by the canonical symlink"

# — root-state: NON-EMPTY real dir → REFUSED with the migration pointer —
mkdir -p "$SB/roots/full"; echo x > "$SB/roots/full/stray"
set +e
"$INIT" carol --no-github --root "$SB/roots/full" 2>"$SB/.full-err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "non-empty real dir must be REFUSED (the divergence class)"
grep -qi 'migration' "$SB/.full-err" || fail "refusal must print a migration pointer"

# — root-state: WRONG-TARGET symlink → REFUSED, never silently re-pointed —
mkdir -p "$SB/elsewhere"; ln -s "$SB/elsewhere" "$SB/roots/wrong"
set +e
"$INIT" dana --no-github --root "$SB/roots/wrong" 2>"$SB/.wrong-err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "wrong-target symlink must be REFUSED"
grep -qi 'migration' "$SB/.wrong-err" || fail "wrong-target refusal must print the migration pointer"

# — vault #N on a machine that already has vaults: child entry, never a refusal —
"$INIT" ewing --no-github --root "$SB/roots/absent" >/dev/null 2>&1 \
  || fail "adding vault #2 on a compliant root must succeed (child entry)"
[ -d "$CANON/vault-ewing" ] || fail "vault #2 must exist alongside vault #1"

# — degraded path: stamps local-only, prints the resume command —
mkdir -p "$SB/shim"; printf '#!/usr/bin/env bash\necho "shim-gh $*" >> "%s/shim-gh.log"\nexit 1\n' "$SB" > "$SB/shim/gh"; chmod +x "$SB/shim/gh"
PATH="$SB/shim:$PATH" AMICO_FORCE_DEGRADED=1 "$INIT" foster --root "$SB/roots/absent" >"$SB/.deg-out" 2>"$SB/.deg-err" \
  || fail "degraded run must succeed locally (no-remote is not an error state)"
FD="$CANON/vault-foster"
grep -q '^provision_state = "local-only"$' "$FD/.amico-vault.toml" \
  || fail "degraded run must stamp provision_state = local-only"
grep -q 'armonia-init foster' "$SB/.deg-out" || fail "degraded run must print the exact resume command"

# — idempotent resume: re-run attaches the remote and stamps provisioned —
git init -q --bare "$SB/bare-resume.git"
PATH="$SB/shim:$PATH" AMICO_RESUME_REMOTE="$SB/bare-resume.git" \
  "$INIT" foster --root "$SB/roots/absent" >/dev/null 2>&1 \
  || fail "resume re-run must succeed (idempotent, exactly one vault dir)"
[ "$(ls "$CANON" | grep -c foster)" = "1" ] || fail "resume must not duplicate the vault dir"
grep -q '^provision_state = "provisioned"$' "$FD/.amico-vault.toml" \
  || fail "resume must stamp provision_state = provisioned"
[ "$(git -C "$FD" remote get-url origin)" = "$SB/bare-resume.git" ] \
  || fail "resume must attach the seam remote"

# — mid-flight-death resume: repo exists, remote unset → same recovery —
git init -q --bare "$SB/bare-mid.git"
mkdir -p "$SB/shim2"
printf '#!/usr/bin/env bash\necho "shim2-gh $*" >> "%s/shim2-gh.log"\nexit 0\n' "$SB" > "$SB/shim2/gh"; chmod +x "$SB/shim2/gh"
PATH="$SB/shim2:$PATH" AMICO_FORCE_DEGRADED=1 "$INIT" gordon --root "$SB/roots/absent" >/dev/null 2>&1
GD="$CANON/vault-gordon"
grep -q 'repo create' "$SB/shim2-gh.log" >/dev/null 2>&1 || true
PATH="$SB/shim2:$PATH" AMICO_RESUME_REMOTE="$SB/bare-mid.git" \
  "$INIT" gordon --root "$SB/roots/absent" >/dev/null 2>&1 \
  || fail "mid-flight-death resume must succeed (resume from the stamp, never duplicate)"
grep -q '^provision_state = "provisioned"$' "$GD/.amico-vault.toml" \
  || fail "mid-flight resume must stamp provisioned"

# — cadence: scheduler file carries the parameter; --cadence rewrites it —
grep -q '^# amico-sync-cadence: 15m$' "$CANON/vault-abigail/systemd/armonia-sync.timer" \
  || fail "minted scheduler file must carry the cadence parameter marker (default 15m)"
"$INIT" hollis --no-github --root "$SB/roots/absent" --cadence 30 >/dev/null 2>&1 \
  || fail "--cadence must not block minting"
grep -q '^# amico-sync-cadence: 30m$' "$CANON/vault-hollis/systemd/armonia-sync.timer" \
  || fail "--cadence 30 must rewrite the marker"

unset AMICO_ENFORCE_ROOT_CONTRACT AMICO_CANONICAL_VAULTS_DATA

echo "PASS: armonia-init smoke test (mint + lint + override + rule + sweep + root-states + degraded/resume + cadence)"
