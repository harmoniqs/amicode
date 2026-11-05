#!/usr/bin/env bash
# Fixture for scripts/armonia-workstation clone lists (harmoniqs/amicode#2135).
# Renamed / archived / retired repos must not be cloned, and --check on a
# machine carrying the old layout must report the stale directories instead of
# passing. Two fake roots only; no network (--check) and no real $HOME touched.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS="$HERE/../scripts/armonia-workstation"
[ -x "$WS" ] || { echo "FAIL: $WS not executable"; exit 1; }
fail() { echo "FAIL: $*"; exit 1; }

SB="$(mktemp -d)"; trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home"; mkdir -p "$HOME"

# --- 1. static clone lists -------------------------------------------------
# Extract the three arrays from the script without executing its main body.
# Only the array bodies, with comments stripped: a comment mentioning a retired
# name must not count as the name being cloned.
BODY="$(sed -n '/^CODE=(/,/syndrome-extraction-demo)/p' "$WS" | sed 's/#.*$//')"
[ -n "$BODY" ] || fail "could not locate the CODE/PKGS/DEMO_REPOS arrays"
CODE_BODY="$(grep -E '^CODE=\(' "$WS" | sed 's/#.*$//')"
echo "$CODE_BODY" | grep -qw 'amicissimo' || fail "CODE must clone amicissimo"
echo "$CODE_BODY" | grep -qw 'amico' && fail "CODE must not clone the renamed amico repo"
echo "$CODE_BODY" | grep -qw 'amico-plugin' && fail "CODE must drop archived amico-plugin"
echo "$CODE_BODY" | grep -qw 'opencode' && fail "CODE must drop retired opencode fork"
echo "$BODY" | grep -qw 'IntonatoQICK.jl' && fail "archived IntonatoQICK.jl must be dropped from PKGS"
echo "$BODY" | grep -qw 'embedded-operators-demo' && fail "archived embedded-operators-demo must be dropped from DEMO_REPOS"

# --- 2. --check on an empty machine: amicissimo is the clone target ---------
OUT="$(HARMONIQS_ROOT="$SB/hq-empty" AMICO_VAULTS_ROOT="$SB/vaults-empty" bash "$WS" --check 2>&1)"
echo "$OUT" | grep -q 'MISSING  amicissimo' || fail "--check on an empty machine must report MISSING amicissimo"
echo "$OUT" | grep -qE 'MISSING  (amico|amico-plugin|opencode)$' && fail "--check must not expect the retired/renamed repos"

# --- 3. --check on the OLD layout must not pass ----------------------------
HQ="$SB/hq-old"
for d in amico amico-plugin opencode; do mkdir -p "$HQ/$d/.git"; done
mkdir -p "$HQ/packages/IntonatoQICK.jl/.git" "$HQ/demos/embedded-operators-demo/.git"
set +e
OUT="$(HARMONIQS_ROOT="$HQ" AMICO_VAULTS_ROOT="$SB/vaults-empty" bash "$WS" --check 2>&1)"
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "--check on the old layout must exit nonzero (stale dirs), got 0"
for d in "$HQ/amico" "$HQ/amico-plugin" "$HQ/opencode" "$HQ/packages/IntonatoQICK.jl" "$HQ/demos/embedded-operators-demo"; do
  echo "$OUT" | grep -q "STALE" && echo "$OUT" | grep -q "$d" || fail "--check must report stale directory $d"
done

# --- 4. --check must never delete anything ----------------------------------
[ -d "$HQ/amico/.git" ] && [ -d "$HQ/opencode/.git" ] || fail "--check must not remove stale checkouts"

echo "PASS: armonia-workstation clone lists (amicissimo in, retired/archived out; --check flags stale layout)"
