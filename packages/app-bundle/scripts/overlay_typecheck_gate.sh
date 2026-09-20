#!/usr/bin/env bash
# Overlay typecheck gate (harmoniqs/amicode#1348).
#
# Companion to engine_typecheck_gate.sh (#1228), which is scoped to the
# `opencode` package. The amicode overlay also modifies SEVEN other materialized
# packages — app, ui, session-ui, core, schema, sdk, llm — none of which the
# `fast` job's `pnpm -r run typecheck` reaches (the overlay is not a pnpm
# workspace member) and none of which the engine gate covers. So a broken type
# in the SolidJS app/ui overlay merged green (exactly how #1338's app changes
# would have merged unverified). This gate closes that hole: it typechecks every
# overlay-touched non-opencode package in the materialized tree.
#
# Unlike the engine gate, this gate carries NO allowlist. #1348 fixed all nine
# pre-existing base-drift errors for real, so the gate is fully fail-closed: ANY
# type error in a covered package fails CI.
#
# `app`'s typecheck script is `tsgo -b` (build mode): it transitively
# typechecks its project references (ui, core, sdk, session-ui). The others are
# still checked explicitly — belt-and-suspenders, and the only coverage for
# packages outside app's ref graph (schema, llm).
set -uo pipefail

MAT="packages/app-bundle/.materialized"

# Overlay-touched packages, as dirs under $MAT/packages. The sdk package
# (@opencode-ai/sdk) lives under sdk/js.
PACKAGES=(app ui session-ui core schema sdk/js llm)

if [ ! -d "$MAT/packages" ]; then
  echo "FAIL: materialized tree missing at $MAT/packages (did materialize run?)"
  exit 1
fi

STATUS=0
for pkg in "${PACKAGES[@]}"; do
  dir="$MAT/packages/$pkg"
  if [ ! -d "$dir" ]; then
    echo "::error::overlay typecheck: package dir missing: $dir"
    STATUS=1
    continue
  fi

  echo "── typecheck: $pkg ──"
  CODE=0
  OUT="$(cd "$dir" && bun run typecheck 2>&1)" || CODE=$?
  echo "$OUT"

  # Fail-closed: the typecheck must actually have executed. `bun run typecheck`
  # echoes the invoked script (`$ tsgo -b` or `$ tsgo --noEmit`) before running;
  # its absence means a silent no-op, which we treat as a failure.
  if ! echo "$OUT" | grep -qE 'tsgo (-b|--noEmit)'; then
    echo "::error::overlay typecheck for '$pkg' did not execute (no tsgo banner) — treating as failure"
    STATUS=1
    continue
  fi

  # No allowlist: every `error TS` is a failure (#1348 fixed all base drift).
  ERRORS="$(echo "$OUT" | grep -E 'error TS' || true)"
  if [ -n "$ERRORS" ]; then
    echo "::error::overlay typecheck found type error(s) in '$pkg' (no allowlist — #1348 fixed all base drift):"
    echo "$ERRORS"
    STATUS=1
    continue
  fi

  if [ "$CODE" -ne 0 ]; then
    echo "::error::overlay typecheck for '$pkg' exited $CODE without TypeScript diagnostics"
    STATUS=1
    continue
  fi

  echo "OK: $pkg typecheck clean"
done

if [ "$STATUS" -ne 0 ]; then
  echo "::error::overlay typecheck gate FAILED"
  exit 1
fi

echo "OK: overlay typecheck clean across ${#PACKAGES[@]} packages (${PACKAGES[*]})"
