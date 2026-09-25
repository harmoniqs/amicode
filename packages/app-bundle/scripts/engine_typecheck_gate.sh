#!/usr/bin/env bash
# Engine typecheck gate (harmoniqs/amicode#1228).
#
# The fork-absorption (#1114) left the overlay engine
# (packages/app-bundle/overlay/packages/opencode) with NO CI typecheck/test
# coverage: it is not a pnpm workspace member, so `pnpm -r run typecheck` skips
# it. This gate restores the engine typecheck the fork ran in its typecheck.yml
# (`bun turbo typecheck`), scoped to the `opencode` package — the engine where
# amicode's overlay changes live.
#
# Any NEW type error fails CI. KNOWN base-drift errors are allowlisted: the
# materialized upstream test tree references symbols that upstream's own src
# tree does not export at the pinned base (e.g. codex `extractResidency`, MCP
# `remove`, HttpRecorder `promptAgnosticMatcher`) — inconsistencies WITHIN the
# upstream release, not caused by amicode's overlay. The allowlist is matched by
# file + TS rule code so line drift does not defeat it. Refresh this list when
# the base pin (manifest upstream_base) moves. The full-monorepo lane and the
# unit-TEST lane are tracked in #1229 / #1233.
set -uo pipefail

MAT="packages/app-bundle/.materialized"
if [ ! -d "$MAT/packages/opencode" ]; then
  echo "FAIL: materialized opencode tree missing at $MAT/packages/opencode (did materialize run?)"
  exit 1
fi

TYPECHECK_STATUS=0
OUT="$(cd "$MAT/packages/opencode" && bun run typecheck 2>&1)" || TYPECHECK_STATUS=$?
echo "$OUT"

# Fail-closed: the typecheck must actually have executed (tsgo prints its banner
# via the package `typecheck` script). Guards against a silent no-op pass.
if ! echo "$OUT" | grep -q 'tsgo --noEmit'; then
  echo "::error::engine typecheck did not execute (no tsgo banner) — treating as failure"
  exit 1
fi

# Known base-drift errors — upstream test files referencing symbols absent from
# upstream's own src tree at the pinned base (upstream_base = v1.18.30). Matched
# by file + TS rule code so line drift does not defeat the allowlist. Refresh
# when the base pin moves.
ALLOW='test/plugin/codex\.test\.ts.*error TS2305|test/server/httpapi-mcp-oauth\.test\.ts.*error TS2322|test/session/llm-native-recorded\.test\.ts.*error TS2339|test/session/snapshot-tool-race\.test\.ts.*error TS2741'

TYPECHECK_ERRORS="$(echo "$OUT" | grep -E 'error TS' || true)"
if [ "$TYPECHECK_STATUS" -ne 0 ] && [ -z "$TYPECHECK_ERRORS" ]; then
  echo "::error::engine typecheck command failed without TypeScript diagnostics"
  exit 1
fi

UNEXPECTED="$(echo "$TYPECHECK_ERRORS" | grep -vE "$ALLOW" || true)"
if [ -n "$UNEXPECTED" ]; then
  echo "::error::engine typecheck found type error(s) NOT in the #1229 base-drift allowlist:"
  echo "$UNEXPECTED"
  exit 1
fi

echo "OK: engine typecheck clean (only the #1229-tracked base-drift errors present)"
