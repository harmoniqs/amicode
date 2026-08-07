# Solve — Background campaigns, logging & HSL

How to run optimizations in the background with a single per-campaign log, chain multi-phase
runs, and handle the HSL linear solver. Loaded on demand from [`../SKILL.md`](../SKILL.md).

## HSL linear solver

HSL (`ma86`, `ma57`, etc.) provides faster linear solvers for Ipopt but requires `HSL_jll`
to be installed and working. If HSL fails with `DYNAMIC_LIBRARY_FAILURE` or
`undefined symbol`, **remove the HSL options** from the script and use Ipopt's default MUMPS
solver instead. Don't waste time debugging HSL linking issues.

## Background execution and logging

Always run optimizations in the background using `nohup` and `&`. Use **one log file per
optimization campaign** (not per script invocation) so all stages, warm-starts, and min-time
runs stream to the same place. Name the log after the campaign, not the script:

```bash
# First run in a campaign — create the log:
cd <project_dir> && nohup julia -t auto --project=. <script_path> [args...] > /tmp/<campaign>.log 2>&1 &

# Subsequent runs in the same campaign — append:
cd <project_dir> && nohup julia -t auto --project=. <script_path> [args...] >> /tmp/<campaign>.log 2>&1 &
```

Example: all Case 1 CZ error mitigation runs go to `/tmp/case1_optimization.log`:
```bash
# Stage 1+2 fidelity
nohup julia -t auto --project=. scripts/error_mitigation/optimize_CZ_case1.jl 500 50 > /tmp/case1_optimization.log 2>&1 &
# Min-time (append to same log)
nohup julia -t auto --project=. scripts/error_mitigation/mintime_CZ_case1.jl 1000 >> /tmp/case1_optimization.log 2>&1 &
```

This gives the user a single `tail -f` to watch the entire campaign.

## Streaming output

After launching, ALWAYS tell the user the log path and how to stream it:

```
Optimization running in background (PID: XXXX). Stream the output with:
  tail -f /tmp/<campaign>.log
```

## Example

```bash
# From inside the demo repo (demos are now standalone repos):
cd bosonic-demo && julia -t auto --project=. scripts/displaced_frame/optimize_CPHASE.jl 300
```

## Multi-Phase Chaining

When running multi-phase optimization (per /setup Rule 1):

```bash
# Phase 1: L-BFGS fidelity (background)
julia -t auto --project=. scripts/optimize_X.jl 300

# Phase 2: Exact Hessian (load checkpoint from Phase 1)
julia -t auto --project=. scripts/optimize_X_hessian.jl 300

# Phase 3: Min-time L-BFGS
julia -t auto --project=. scripts/optimize_X_mintime.jl 1000
```

Between phases, check:
1. Fidelity improved (or at least didn't regress)
2. Constraints are satisfied (inf_pr near zero)
3. Duration changed by expected amount
