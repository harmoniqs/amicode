#!/usr/bin/env bash
# 0.1d producer round-trip: run amico-run on a minimal emitter so it produces a
# REAL run-dir (run.toml + FINISHED from the orchestrator, result.toml from the
# Julia emitter), then validate the FRESHLY-EMITTED artifacts with the Julia
# validator against the shared schemas. Exercises the producer seam, not just
# committed fixtures (Jack's #31). NOTE: the orchestrator writes run.toml/FINISHED;
# the Julia producer writes result.toml — that's the one this round-trip pins.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNS="$(mktemp -d)/runs"

node "$ROOT/packages/amico-run/dist/amico-run.js" \
  "$ROOT/packages/schema/julia/emit_fixture.jl" --runs-root "$RUNS" --julia julia

RUNDIR="$(dirname "$(find "$RUNS" -maxdepth 2 -name run.toml | head -1)")"
echo "emitted run-dir: $RUNDIR"; ls "$RUNDIR"

VJL="julia --project=$ROOT/packages/schema/julia $ROOT/packages/schema/julia/validate.jl"
$VJL "$RUNDIR/run.toml" run
$VJL "$RUNDIR/result.toml" result
$VJL "$RUNDIR/FINISHED" finished
echo "PRODUCER ROUND-TRIP PASS"
