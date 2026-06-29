#!/usr/bin/env bash
# 0.1d AC6 (anti-drift, exercised not asserted): mutating the SINGLE shared schema
# must flip BOTH validators. The TS side bakes schemas into dist/ at BUILD time
# (import … with {type:"json"}), so we perturb the shared file → REBUILD TS →
# assert BOTH the TS bin AND the Julia validator now reject a previously-valid
# fixture → revert. Proves the cross-language single source end-to-end (Jack's #31).
set -uo pipefail   # NOT -e: validate returning 64 is expected and handled below
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCHEMA="$ROOT/packages/schema/schemas/run.schema.json"
FIX="$ROOT/packages/schema/test/fixtures/valid/run.toml"

cleanup() { git -C "$ROOT" checkout -- "$SCHEMA" 2>/dev/null; pnpm --filter @amicode/schema build >/dev/null 2>&1 || true; }
trap cleanup EXIT

# sanity: the fixture is valid BEFORE perturbing
"$ROOT/packages/schema/launcher/amico-validate" "$FIX" --schema run >/dev/null || { echo "precondition failed: fixture not valid"; exit 1; }

# perturb: add a bogus required key to the shared schema, then re-bake TS
node -e "const fs=require('fs'),f='$SCHEMA',s=JSON.parse(fs.readFileSync(f));s.required.push('__drift_canary__');fs.writeFileSync(f,JSON.stringify(s,null,2))"
pnpm --filter @amicode/schema build >/dev/null

# both must now REJECT (exit 64). If either still passes (exit 0), AC6 is violated.
if "$ROOT/packages/schema/launcher/amico-validate" "$FIX" --schema run >/dev/null 2>&1; then
  echo "AC6 FAIL: TS validator did NOT flip after the shared schema was perturbed + rebuilt"; exit 1
fi
if julia --project="$ROOT/packages/schema/julia" "$ROOT/packages/schema/julia/validate.jl" "$FIX" run >/dev/null 2>&1; then
  echo "AC6 FAIL: Julia validator did NOT flip on the perturbed shared schema"; exit 1
fi
echo "AC6 PASS — perturbing the shared schema flipped BOTH the TS bin and the Julia validator"
