#!/usr/bin/env bash
# 0.1d AC6 (anti-drift, exercised not asserted): mutating the SINGLE shared schema
# must flip BOTH validators. The TS side bakes schemas into dist/ at BUILD time
# (import … with {type:"json"}), so we perturb the shared file → REBUILD TS →
# assert BOTH the TS bin AND the Julia validator now reject a previously-valid
# fixture → revert. Proves the cross-language single source end-to-end (Jack's #31).
#
# Two cases:
#   run          — the flat schema (top-level `required`): canary a required key.
#   problemspec  — the first oneOf + if/then schema: canary the CONTROL branch's
#                  `required` (oneOf[0]); a control fixture then matches ZERO
#                  branches → both validators reject. This exercises the drift
#                  gate on the conditional schema, not just the flat one.
set -uo pipefail   # NOT -e: validate returning 64 is expected and handled below
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VALIDATE="$ROOT/packages/schema/launcher/amico-validate"
JULIA_PROJECT="$ROOT/packages/schema/julia"
JULIA_VALIDATE="$JULIA_PROJECT/validate.jl"
SCHEMAS_DIR="$ROOT/packages/schema/schemas"

# Revert EVERY schema + rebuild TS on exit so a mid-run failure never leaves the
# tree perturbed (the trap covers both cases' schema files at once).
cleanup() { git -C "$ROOT" checkout -- "$SCHEMAS_DIR" 2>/dev/null; pnpm --filter @amicode/schema build >/dev/null 2>&1 || true; }
trap cleanup EXIT

rebuild() { pnpm --filter @amicode/schema build >/dev/null; }
ts_validate()    { "$VALIDATE" "$1" --schema "$2" >/dev/null 2>&1; }
julia_validate() { julia --project="$JULIA_PROJECT" "$JULIA_VALIDATE" "$1" "$2" >/dev/null 2>&1; }

# assert_flip <kind> <fixture> <schema-file> <node-perturb-expr>
#   <node-perturb-expr> mutates the parsed schema object `s` to inject a canary
#   into the relevant `required` array (flat vs oneOf branch differ per schema).
assert_flip() {
  local kind="$1" fix="$2" schema="$3" perturb="$4"
  # Start from a clean, freshly-built schema so the "flip" starts from a true accept.
  git -C "$ROOT" checkout -- "$schema" 2>/dev/null; rebuild
  ts_validate    "$fix" "$kind" || { echo "precondition failed: $fix not valid as $kind (TS)";    exit 1; }
  julia_validate "$fix" "$kind" || { echo "precondition failed: $fix not valid as $kind (Julia)"; exit 1; }
  # Perturb: inject a bogus required key into the shared schema, then re-bake TS.
  node -e "const fs=require('fs'),f='$schema',s=JSON.parse(fs.readFileSync(f));$perturb;fs.writeFileSync(f,JSON.stringify(s,null,2))"
  rebuild
  # Both must now REJECT. If either still passes, the single-source guarantee is broken.
  if ts_validate "$fix" "$kind"; then
    echo "AC6 FAIL ($kind): TS validator did NOT flip after the shared schema was perturbed + rebuilt"; exit 1
  fi
  if julia_validate "$fix" "$kind"; then
    echo "AC6 FAIL ($kind): Julia validator did NOT flip on the perturbed shared schema"; exit 1
  fi
  git -C "$ROOT" checkout -- "$schema" 2>/dev/null
  echo "AC6 PASS ($kind) — perturbing the shared schema flipped BOTH the TS bin and the Julia validator"
}

# Case 1: flat schema — top-level required.
assert_flip run \
  "$ROOT/packages/schema/test/fixtures/valid/run.toml" \
  "$SCHEMAS_DIR/run.schema.json" \
  "s.required.push('__drift_canary__')"

# Case 2: problemspec — perturb the CONTROL branch's required (oneOf[0]) so a
# control fixture matches zero branches. Guards the conditional schema too.
assert_flip problemspec \
  "$ROOT/packages/schema/test/fixtures/valid/problemspec-x-control.toml" \
  "$SCHEMAS_DIR/problemspec.schema.json" \
  "s.oneOf[0].required.push('__drift_canary__')"

echo "AC6 PASS — both the flat (run) and conditional (problemspec) schemas flip BOTH validators"
