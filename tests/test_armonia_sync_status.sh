#!/usr/bin/env bash
# Fixture harness for the sync-status sidecar (vault-mgmt spec M3, #360).
# Builds a fake vaults root with: a healthy clone, a conflicted clone (the
# founding-incident shape: unmerged tree + origin ahead), a read-only
# personal clone, a symlinked alias, a never-synced orphan, a hand-written
# behind-only record, and an aged record — then asserts the writer and the
# renderer end-to-end. No network: all remotes are local bare repos.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$HERE/../scripts/armonia-sync-once"
STATUS="$HERE/../scripts/armonia-vault-status"
[ -x "$SYNC" ] || { echo "FAIL: $SYNC not executable"; exit 1; }
[ -x "$STATUS" ] || { echo "FAIL: $STATUS not executable"; exit 1; }

fail() { echo "FAIL: $*"; exit 1; }

SB="$(mktemp -d)"
trap 'chmod -R u+w "$SB" 2>/dev/null; rm -rf "$SB"' EXIT
ROOT="$SB/vaults"; OPS="$SB/ops"; HOME_FIX="$SB/home"
mkdir -p "$ROOT" "$OPS" "$HOME_FIX"

mk_vault() {  # <name> <kind> → clone of a fresh bare, prints clone path
  local nm="$1" kd="$2"
  git init -q --bare -b main "$SB/bare-$nm.git"
  git clone -q "$SB/bare-$nm.git" "$ROOT/$nm"
  printf 'kind = "%s"\nname = "%s"\n' "$kd" "$nm" > "$ROOT/$nm/.amico-vault.toml"
  git -C "$ROOT/$nm" add -A && git -C "$ROOT/$nm" commit -qm init
  git -C "$ROOT/$nm" push -q origin main
}

# ── fixtures ────────────────────────────────────────────────────────────────
mk_vault vault-healthy personal
mk_vault vault-conflicted restricted
mk_vault vault-ropersonal personal

# conflicted: unmerged merge state (the partitura shape) + origin 2 ahead
git clone -q "$SB/bare-vault-conflicted.git" "$SB/other"
echo "line: theirs" > "$SB/other/f.md"; git -C "$SB/other" add -A; git -C "$SB/other" commit -qm theirs
echo "line2: theirs" >> "$SB/other/f.md"; git -C "$SB/other" commit -qam theirs2
git -C "$SB/other" push -q origin main
echo "line: ours" > "$ROOT/vault-conflicted/f.md"; git -C "$ROOT/vault-conflicted" commit -qam ours
git -C "$ROOT/vault-conflicted" fetch -q origin
git -C "$ROOT/vault-conflicted" merge --no-edit --no-commit origin/main >/dev/null 2>&1 || true
git -C "$ROOT/vault-conflicted" reset -q --merge HEAD >/dev/null 2>&1 || true
# leave unmerged paths: re-run the merge without resolving (the incident state)
git -C "$ROOT/vault-conflicted" merge --no-edit origin/main >/dev/null 2>&1 || true

# ro-personal: strip write bits (expected-failure mount: pull must fail)
chmod -R a-w "$ROOT/vault-ropersonal"

# ── one sync cycle: the WRITER half ─────────────────────────────────────────
AMICO_HOME="$HOME_FIX" AMICO_VAULTS_ROOT="$ROOT" AMICO_OPS_ROOT="$OPS" \
  bash "$SYNC" >/dev/null 2>&1 || true

R="$OPS/sync-status"
KEY_H=$(python3 -c "import os,sys;print(os.path.realpath('$ROOT/vault-healthy').strip('/').replace('/','_'))")
KEY_C=$(python3 -c "import os,sys;print(os.path.realpath('$ROOT/vault-conflicted').strip('/').replace('/','_'))")
KEY_R=$(python3 -c "import os,sys;print(os.path.realpath('$ROOT/vault-ropersonal').strip('/').replace('/','_'))")
RH="$R/$KEY_H.json"; RC="$R/$KEY_C.json"; RR="$R/$KEY_R.json"

[ -f "$RH" ] || fail "healthy clone must have a record (written every cycle, every mount)"
[ -f "$RC" ] || fail "conflicted clone must have a record INCLUDING the failure"
[ -f "$RR" ] || fail "ro clone must have a record (failures are recorded, never swallowed)"

python3 - "$RH" <<'PY' || exit 1
import json, sys
r = json.load(open(sys.argv[1]))
assert r["last_success"], "healthy: last_success must be recorded (success path writes)"
assert r["consecutive_failures"] == 0, "healthy: zero failures"
assert r["behind_count"] == 0, f"healthy: behind 0, got {r['behind_count']}"
PY

python3 - "$RC" <<'PY' || exit 1
import json, sys
r = json.load(open(sys.argv[1]))
assert r["consecutive_failures"] == 1, f"conflicted: failures==1, got {r['consecutive_failures']}"
assert r["failure_reason"], "conflicted: the reason must be recorded"
assert isinstance(r["behind_count"], int) and r["behind_count"] >= 2, \
    f"conflicted: behind_count must be a non-null integer ≥ 2 (the 139-behind writer half), got {r['behind_count']}"
assert not r["fetch_blocked"], "conflicted: fetch succeeds (pull is what fails)"
assert r["kind"] == "restricted", "conflicted: kind carried from the toml"
PY

python3 - "$RR" <<'PY' || exit 1
import json, sys
r = json.load(open(sys.argv[1]))
assert r["consecutive_failures"] >= 1, "ro: failures recorded"
assert r["kind"] == "personal", "ro: kind personal (ro-by-policy scope)"
PY

# ── the RENDERER: states, dedupe, never-silent ──────────────────────────────
# alias: symlinked second name for the SAME storage → one row, one record
ln -s "$ROOT/vault-conflicted" "$ROOT/alias-conflicted"

# orphan: mounted, never synced → UNKNOWN
mk_vault vault-orphan personal

# handrec: behind-only record (render half of the detector; zero failures)
mk_vault vault-handrec personal
KEY_HR=$(python3 -c "import os,sys;print(os.path.realpath('$ROOT/vault-handrec').strip('/').replace('/','_'))")
python3 - "$R/$KEY_HR.json" "$ROOT/vault-handrec" <<'PY'
import json, sys, time, os
p, mount = sys.argv[1], sys.argv[2]
now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
json.dump({"display_name": "vault-handrec", "kind": "personal",
           "path": os.path.realpath(mount),
           "last_success": now, "last_failure": None, "failure_reason": None,
           "consecutive_failures": 0, "behind_count": 51, "fetch_blocked": False,
           "threshold": 50, "cadence_minutes": 15, "updated": now}, open(p, "w"))
PY

OUT="$(AMICO_HOME="$HOME_FIX" AMICO_VAULTS_ROOT="$ROOT" AMICO_OPS_ROOT="$OPS" bash "$STATUS")"

grep -q 'vault-healthy .*state=OK' <<<"$OUT" || fail "healthy must render OK; got: $OUT"
grep -q 'vault-conflicted .*state=STALE' <<<"$OUT" || fail "conflicted must render STALE (failures path)"
grep -q 'vault-handrec .*state=STALE' <<<"$OUT" || fail "behind-only record must render STALE (render half of the detector)"
grep -q 'vault-ropersonal .*state=ro-by-policy' <<<"$OUT" || fail "ro personal must render ro-by-policy (muted, self-contained)"
grep -q 'vault-orphan .*state=UNKNOWN' <<<"$OUT" || fail "never-synced mount must render UNKNOWN (never silently fresh)"

# alias dedupe: one row per resolved storage — the conflicted vault renders once
N=$(grep -c 'vault-conflicted' <<<"$OUT")
[ "$N" -eq 1 ] || fail "symlinked alias must collapse to ONE row (got $N rows mentioning the conflicted vault)"

# ── ZOMBIE: a dead scheduler must not read as a quiet all-clear ─────────────
sed -i.bak -E 's/"last_success": "[^"]+"/"last_success": "2026-01-01T00:00:00+0000"/; s/"updated": "[^"]+"/"updated": "2026-01-01T00:00:00+0000"/' "$RH" && rm -f "$RH.bak"
OUT2="$(AMICO_HOME="$HOME_FIX" AMICO_VAULTS_ROOT="$ROOT" AMICO_OPS_ROOT="$OPS" bash "$STATUS")"
grep -q 'vault-healthy .*state=ZOMBIE' <<<"$OUT2" || fail "an aged record must render ZOMBIE (3× cadence age check)"

# ── --strict: nonzero when anything is not OK ───────────────────────────────
AMICO_HOME="$HOME_FIX" AMICO_VAULTS_ROOT="$ROOT" AMICO_OPS_ROOT="$OPS" bash "$STATUS" --strict >/dev/null 2>&1 \
  && fail "--strict must exit nonzero when a non-OK state exists" || true

echo "PASS: sync-status sidecar (writer: both paths + non-null behind; renderer: STALE/UNKNOWN/ZOMBIE/ro-by-policy + alias dedupe)"
