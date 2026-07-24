#!/usr/bin/env bash
# Cross-repo vendoring-drift gate (Plan-2 Task 9). The vendored problemspec schemas
# in packages/schema/schemas/ must be BYTE-IDENTICAL to the schema the pinned
# Piccolo/Piccolissimo commit emitted. We git-FETCH the committed source file at the
# sha recorded in each *.sha sidecar and `cmp` — we NEVER re-run regenerate.jl here
# (review correction #1: no Julia, and no MANDATORY private dep, in amicode CI).
#
#   OSS variant  (problemspec.oss.schema.json) ← PUBLIC  harmoniqs/Piccolo.jl.
#                Tokenless raw fetch; a reachable-but-differing source reds CI.
#   FULL variant (problemspec.schema.json)     ← PRIVATE harmoniqs/Piccolissimo.jl.
#                The authoritative full-variant drift gate lives in Piccolissimo's
#                OWN CI (correction #1). Checked here ONLY when PICCOLISSIMO_SCHEMA_TOKEN
#                is provided (opt-in) — no mandatory private dep in amicode CI.
#
# Failure model:
#   - source REACHABLE at the pinned sha but bytes DIFFER  → DRIFT → hard fail (exit 1).
#   - source NOT reachable at the pinned sha               → WARN + skip (the emission
#     side, Piccolo/Piccolissimo Tasks 1-2, isn't pushed yet). The gate auto-hardens
#     once the source is pushed: a reachable source that drifts always reds.
#
# Local test seam: set VENDOR_DRIFT_SRC_BASE=<dir> to resolve <path> from a local
# tree instead of raw.githubusercontent (inert in CI).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCHEMAS_DIR="$ROOT/packages/schema/schemas"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
rc=0

# read `key = "value"` (or bare value) from a .sha sidecar (TOML-ish)
sidecar_val() { grep -E "^$2[[:space:]]*=" "$1" | head -1 | sed -E 's/^[^=]*=[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/'; }

# fetch <repo> <sha> <path> <out> [token] → 0 on success, nonzero if unreachable
fetch() {
  local repo="$1" sha="$2" path="$3" out="$4" token="${5:-}"
  if [ -n "${VENDOR_DRIFT_SRC_BASE:-}" ]; then
    cp "$VENDOR_DRIFT_SRC_BASE/$path" "$out" 2>/dev/null; return $?
  fi
  local url="https://raw.githubusercontent.com/$repo/$sha/$path"
  # curl's own stderr is suppressed — check_variant emits an actionable warning/error.
  if [ -n "$token" ]; then
    curl -fsL -H "Authorization: token $token" -o "$out" "$url" 2>/dev/null
  else
    curl -fsL -o "$out" "$url" 2>/dev/null
  fi
}

# check_variant <vendored-file> <token> <label>
check_variant() {
  local vendored="$1" token="$2" label="$3"
  local sidecar="$vendored.sha"
  local repo sha path
  repo="$(sidecar_val "$sidecar" repo)"; sha="$(sidecar_val "$sidecar" sha)"; path="$(sidecar_val "$sidecar" path)"
  echo "[$label] vendored $(basename "$vendored") ← $repo @ $sha ($path)"
  local fetched="$TMP/$(basename "$vendored").src"
  if ! fetch "$repo" "$sha" "$path" "$fetched" "$token"; then
    echo "::warning::[$label] pinned source $repo@$sha:$path not reachable — SKIPPING byte-compare (emission side not pushed yet? Piccolo/Piccolissimo Tasks 1-2). The gate hardens once the source is pushed."
    return 0
  fi
  if cmp -s "$vendored" "$fetched"; then
    echo "[$label] OK — vendored copy is byte-identical to the pinned source"
    return 0
  fi
  echo "::error::[$label] DRIFT: vendored $(basename "$vendored") differs from $repo@$sha:$path — re-vendor (run regenerate.jl in $repo, copy the emitted file, bump the .sha sidecar)"
  return 1
}

# OSS — public Piccolo, always attempted (tokenless).
check_variant "$SCHEMAS_DIR/problemspec.oss.schema.json" "" "oss" || rc=1

# FULL — private Piccolissimo; opt-in via token (no mandatory private dep, correction #1).
if [ -n "${PICCOLISSIMO_SCHEMA_TOKEN:-}" ] || [ -n "${VENDOR_DRIFT_SRC_BASE:-}" ]; then
  check_variant "$SCHEMAS_DIR/problemspec.schema.json" "${PICCOLISSIMO_SCHEMA_TOKEN:-}" "full" || rc=1
else
  echo "[full] SKIP — PICCOLISSIMO_SCHEMA_TOKEN not set; the full-variant drift gate is authoritative in Piccolissimo's private CI (correction #1)"
fi

[ "$rc" -eq 0 ] && echo "vendoring-drift: OK (no drift detected)" || echo "vendoring-drift: FAIL (drift detected — see errors above)"
exit $rc
