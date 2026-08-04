---
name: multistart
description: Dispatch K parallel cold-start optimizations for a single (platform, gate), return best. Use when stagnation cascade is detected.
agents: [orchestrator, experimenter]
surface: public
scenarios: [cz-gate-seed, benchmark-against-baseline]
---

# Multistart — Parallel Cold-Start Dispatch

Break stagnation by running K independent cold-start optimizations in parallel and keeping the best.

## Parameters

- `platform`, `gate` — what to optimize
- `K` — number of parallel starts (default: 5)
- `max_iter` — per-start iteration budget (default: 500)
- `pulse_type`, `N_knots`, `T_init` — override defaults or use platform skill defaults

## Workflow

1. Read platform skill for default hyperparameters
2. Generate K independent Julia scripts in `~/.amico/ops/scratchpad/{session_id}/multistart/` with different random seeds (`Random.seed!(k)` for k=1..K)
3. Run all K in parallel via Bash background processes:
   ```bash
   for k in $(seq 1 $K); do
     OPENBLAS_NUM_THREADS=1 julia -t1 --project={demo} script_$k.jl \
       > logs/start_$k.log 2>&1 &
     pids[$k]=$!
   done
   wait "${pids[@]}"
   ```
   Use `-t1` (not `-t auto`) to avoid thread over-subscription. Memory guard: if system has <4GB free RAM per process (estimate from Hilbert space dim²), reduce K or run sequentially.
4. Collect results from each log: parse `AMICO_RESULT_FIDELITY`, `AMICO_RESULT_DURATION`, `AMICO_RESULT_STATUS`
5. Select best by fidelity (break ties by shorter duration)
6. **All-fail case**: If all K starts fail, report `status: error`, `failure_mode: multistart_all_failed`. Create experiment note summarizing failures.
7. **Success case**: Save best to catalog, create experiment note summarizing all K starts (best fidelity, worst fidelity, convergence count K_converged/K)
8. Report: best fidelity, distribution, convergence statistics

## When to reach for it

- **Stagnation cascade**: 3+ consecutive solves on the same (platform, gate) with no
  improvement. One more attempt from the same basin is unlikely to help; K attempts from K
  basins is.
- **A genuinely new problem** with no warm-start candidate — a multistart campaign is a
  better cold start than a single cold start (see `warm-start`, seed source 4).
- **Baseline difficulty measurement**: the fidelity *distribution* over K starts is the
  honest answer to "how hard is this problem", and it is the number to quote when comparing
  against a warm start.

Each individual start follows the `/solve` conventions (BLAS threads, background launch,
one log per campaign), and each result still needs the `simulate` re-rollout check before
the best one is reported — K unverified numbers are not better than one.
