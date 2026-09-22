#!/usr/bin/env bash
# Engine unit-test lane (harmoniqs/amicode#1233) — NON-BLOCKING (see ci.yml).
#
# Runs the overlay opencode test suite against the materialized tree, the way the
# fork's test.yml did (a single shared bun process — fast, ~5-6 min), scoped to the
# engine. Companion to the typecheck gate (#1228). This lane RUNS the overlay tests
# in CI and reports; it does not gate merges until the suite is hardened (#1239).
#
# The suite has known instability tracked in #1239 (cross-test pollution,
# timing-flakiness, positive cross-test dependencies) and one quarantined spec
# conflict (session.test.ts, it.instance.skip, #1239). Because the lane is
# non-blocking, those are surfaced in the logs rather than gating. Once #1239
# hardens the suite, drop continue-on-error in ci.yml to make this a real gate
# (per-file isolation — see git history — is the fallback if pollution persists).
#
# Excluded: test/session/llm-native-recorded.test.ts fails at RUNTIME on the stale
# base pin (HttpRecorder.promptAgnosticMatcher absent), tracked in #1229.
set -uo pipefail

MAT="packages/app-bundle/.materialized"
if [ ! -d "$MAT/packages/opencode" ]; then
  echo "FAIL: materialized opencode tree missing at $MAT/packages/opencode (did materialize run?)"
  exit 1
fi
cd "$MAT/packages/opencode"

# find-emitted paths carry no spaces, so word-splitting the list is safe.
FILES="$(find test -name '*.test.ts' | grep -vE 'test/session/llm-native-recorded\.test\.ts' | sort)"
COUNT="$(printf '%s\n' "$FILES" | grep -c '.')"

# Fail-closed: a suite that silently collapsed to a handful of files must red.
if [ "$COUNT" -lt 200 ]; then
  echo "FAIL: only $COUNT engine test files discovered (fail-closed floor is 200) — suite did not materialize"
  exit 1
fi

echo "running $COUNT engine test files in one shared process (base-drift #1229 excluded)"
# shellcheck disable=SC2086  # intentional word-split of the space-free path list
GITHUB_ACTIONS=false OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true bun test $FILES --timeout 30000
