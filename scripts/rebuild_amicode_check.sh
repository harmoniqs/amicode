#!/usr/bin/env bash
# rebuild_amicode_check.sh — the machine-checked acceptance harness for #1135.
#
# Runs every FALSIFIABLE acceptance criterion for the fork-free rebuild scripts
# as an executable assertion, printing PASS/FAIL/SKIP per AC. Exit 0 iff every
# non-skipped AC passes. The heavy end-to-end build (AC9) is opt-in behind
# RUN_FULL_BUILD=1 so the static/behavioral gates stay fast.
#
#   bash scripts/rebuild_amicode_check.sh              # static + behavioral ACs
#   RUN_FULL_BUILD=1 bash scripts/rebuild_amicode_check.sh   # + the real local build
#
# This harness is itself excluded from the fork-reference grep (it names the
# forbidden tokens only to assert their ABSENCE).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS_DIR="$REPO_ROOT/scripts"
UNIFIED="$SCRIPTS_DIR/rebuild_amicode.sh"
SHIM_LOCAL="$SCRIPTS_DIR/rebuild_amicode_locally.sh"
SHIM_MAIN="$SCRIPTS_DIR/rebuild_amicode_remotely.sh"
THREE=("$UNIFIED" "$SHIM_LOCAL" "$SHIM_MAIN")

pass_n=0
fail_n=0
skip_n=0
pass() { printf 'PASS  %s\n' "$1"; pass_n=$((pass_n + 1)); }
fail() { printf 'FAIL  %s\n    %s\n' "$1" "${2:-}"; fail_n=$((fail_n + 1)); }
skip() { printf 'SKIP  %s\n    %s\n' "$1" "${2:-}"; skip_n=$((skip_n + 1)); }

# ── AC0: the three scripts exist ────────────────────────────────────────────
missing=0
for f in "${THREE[@]}"; do
  [ -f "$f" ] || { echo "    missing: $f"; missing=1; }
done
if [ "$missing" -eq 0 ]; then pass "AC0 three scripts present"; else
  fail "AC0 three scripts present" "one or more scripts are missing"; fi

# ── AC1: fork-references == 0 ───────────────────────────────────────────────
# grep -rnE over the three scripts must yield zero matches.
fork_hits="$(grep -rnE 'harmoniqs/opencode|OPENCODE_ROOT|fetch_opencode[^\n]*--release' "${THREE[@]}" 2>/dev/null || true)"
if [ -z "$fork_hits" ]; then
  pass "AC1 fork-references == 0"
else
  fail "AC1 fork-references == 0" "$fork_hits"
fi

# ── AC2: bash -n on all three ───────────────────────────────────────────────
bn_err=""
for f in "${THREE[@]}"; do
  [ -f "$f" ] || continue
  out="$(bash -n "$f" 2>&1)" || bn_err+="$f: $out"$'\n'
done
if [ -z "$bn_err" ]; then pass "AC2 bash -n == 0"; else fail "AC2 bash -n == 0" "$bn_err"; fi

# ── AC3: shellcheck == 0 findings ───────────────────────────────────────────
if command -v shellcheck >/dev/null 2>&1; then
  sc_out="$(shellcheck "${THREE[@]}" 2>&1)"; sc_rc=$?
  if [ "$sc_rc" -eq 0 ]; then pass "AC3 shellcheck == 0"; else fail "AC3 shellcheck == 0" "$sc_out"; fi
else
  skip "AC3 shellcheck" "shellcheck not installed on this host"
fi

# ── AC4: exactly two modes; unknown --mode exits non-zero with a usage msg ──
if [ -f "$UNIFIED" ]; then
  out="$(bash "$UNIFIED" --mode bogus --dry-run 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qiE 'usage|--mode local\|main|unknown mode'; then
    pass "AC4 unknown --mode exits non-zero with usage"
  else
    fail "AC4 unknown --mode exits non-zero with usage" "rc=$rc out=$out"
  fi
  # both valid modes are accepted by the parser (dry-run stops before work)
  lo="$(bash "$UNIFIED" --mode local --dry-run 2>&1)"; lrc=$?
  mo="$(bash "$UNIFIED" --mode main --dry-run 2>&1)"; mrc=$?
  if [ "$lrc" -eq 0 ] && [ "$mrc" -eq 0 ] \
     && printf '%s' "$lo" | grep -qi 'mode=local' \
     && printf '%s' "$mo" | grep -qi 'mode=main'; then
    pass "AC4b both local and main modes parse"
  else
    fail "AC4b both local and main modes parse" "local(rc=$lrc): $lo | main(rc=$mrc): $mo"
  fi
else
  fail "AC4 unknown --mode" "$UNIFIED missing"
fi

# ── AC5: shim precedence — _locally.sh --mode main still runs local ─────────
if [ -f "$SHIM_LOCAL" ]; then
  out="$(bash "$SHIM_LOCAL" --mode main --dry-run 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi 'mode=local'; then
    pass "AC5 local shim precedence (forwarded --mode main ignored)"
  else
    fail "AC5 local shim precedence" "rc=$rc out=$out"
  fi
  # the main shim resolves to main
  mo="$(bash "$SHIM_MAIN" --dry-run 2>&1)"; mrc=$?
  if [ "$mrc" -eq 0 ] && printf '%s' "$mo" | grep -qi 'mode=main'; then
    pass "AC5b main shim resolves to main"
  else
    fail "AC5b main shim resolves to main" "rc=$mrc out=$mo"
  fi
else
  fail "AC5 shim precedence" "$SHIM_LOCAL missing"
fi

# ── AC6: main-mode dirty-tree guard refuses before checkout ─────────────────
# Drive the guard function in isolation against a simulated dirty tree.
if [ -f "$UNIFIED" ]; then
  tmp="$(mktemp -d)"
  (
    cd "$tmp" || exit 1
    git init -q
    git config user.email t@t; git config user.name t
    echo a > a.txt; git add a.txt; git commit -qm init
    echo dirty >> a.txt   # now dirty
  )
  # AMICODE_ROOT points the guard at the dirty repo; --mode main must refuse.
  out="$(AMICODE_ROOT="$tmp" bash "$UNIFIED" --mode main --yes --check-git-only 2>&1)"; rc=$?
  rm -rf "$tmp"
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qiE 'dirty|refus|uncommitted'; then
    pass "AC6 main-mode dirty-tree guard refuses"
  else
    fail "AC6 main-mode dirty-tree guard refuses" "rc=$rc out=$out"
  fi
else
  fail "AC6 dirty guard" "$UNIFIED missing"
fi

# ── AC7: --yes fails closed on the bun network install ──────────────────────
# When bun is absent and --yes is given (without --allow-bun-install), the
# script must NOT run the curl|bash installer — it must refuse.
if [ -f "$UNIFIED" ]; then
  fakebin="$(mktemp -d)"
  # Shadow bun with nothing, and shadow curl with a sentinel that records a call.
  cat > "$fakebin/curl" <<'EOF'
#!/usr/bin/env bash
echo "CURL_WAS_CALLED $*" >> "$CURL_SENTINEL"
exit 0
EOF
  chmod +x "$fakebin/curl"
  sentinel="$(mktemp)"
  : > "$sentinel"
  # PATH keeps node (bun preflight runs AFTER node) but the script's bun probe
  # must miss: fakebin first (curl sentinel), real dirs for node/pnpm/git, and
  # AMICODE_BUN pointed at a nonexistent path so resolve_bun fails.
  node_dir="$(dirname "$(command -v node)")"
  pnpm_dir="$(dirname "$(command -v pnpm 2>/dev/null || echo /usr/bin/pnpm)")"
  out="$(PATH="$fakebin:$node_dir:$pnpm_dir:/usr/bin:/bin" AMICODE_BUN=/nonexistent/bun CURL_SENTINEL="$sentinel" \
        bash "$UNIFIED" --mode local --yes --check-deps-only 2>&1)"; rc=$?
  called="$(cat "$sentinel" 2>/dev/null || true)"
  rm -rf "$fakebin" "$sentinel"
  if [ "$rc" -ne 0 ] && [ -z "$called" ] && printf '%s' "$out" | grep -qiE 'bun|allow-bun-install'; then
    pass "AC7 --yes fails closed on bun network install"
  else
    fail "AC7 --yes fails closed on bun network install" "rc=$rc curl_called='$called' out=$out"
  fi
else
  fail "AC7 --yes bun fail-closed" "$UNIFIED missing"
fi

# ── AC8: atomic + crash-safe deploy (dist+binary revert together; recovery) ─
# Drive the deploy helpers in a sandbox via --self-test-deploy, which exercises
# (a) a swap that fails mid-flight leaves NO half-applied state (dist and binary
# both original), and (b) a stranded dist from a prior crash is recovered on the
# next run. The unified script implements this behind the hidden flag.
if [ -f "$UNIFIED" ]; then
  out="$(bash "$UNIFIED" --self-test-deploy 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi 'SELFTEST_DEPLOY_OK'; then
    pass "AC8 atomic + crash-safe deploy self-test"
  else
    fail "AC8 atomic + crash-safe deploy self-test" "rc=$rc out=$out"
  fi
else
  fail "AC8 deploy self-test" "$UNIFIED missing"
fi

# ── AC9: real --mode local --yes build → binary + .source == overlay <sha> ──
if [ "${RUN_FULL_BUILD:-0}" = "1" ]; then
  key="$(node -e 'process.stdout.write(process.platform+"-"+process.arch)')"
  fork_sha="$(node -e 'process.stdout.write((require("'"$REPO_ROOT"'/packages/app-bundle/manifest.json").fork_sha)||"")')"
  bash "$SHIM_LOCAL" --yes; brc=$?
  bin="$REPO_ROOT/packages/extension/vendor/opencode/$key/opencode"
  src="$REPO_ROOT/packages/extension/vendor/opencode/$key/.source"
  if [ "$brc" -eq 0 ] && [ -x "$bin" ] && [ "$(cat "$src" 2>/dev/null)" = "overlay $fork_sha" ]; then
    pass "AC9 real local build produced binary + .source"
  else
    fail "AC9 real local build" "rc=$brc bin=$bin exists=$([ -x "$bin" ] && echo y || echo n) source='$(cat "$src" 2>/dev/null)'"
  fi
else
  skip "AC9 real local build" "set RUN_FULL_BUILD=1 to run the heavy end-to-end build"
fi

echo ""
echo "── summary: $pass_n passed, $fail_n failed, $skip_n skipped ──"
[ "$fail_n" -eq 0 ]
