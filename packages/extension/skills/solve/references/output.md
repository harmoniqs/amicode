# Solve — Reporting, saving & checkpoints

What to check and report after a run, the save-between-stages requirement, how to parse
Ipopt output, and how to restart from a checkpoint. Loaded on demand from
[`../SKILL.md`](../SKILL.md).

## After running

- Check the pre-solve diagnostics first: initial fidelity, problem structure (NLP
  vars/constraints/objective), pulse summary
- Report the final fidelity and wall time
- Note any warnings (e.g., missing Δt_bounds, HSL failures)
- If fidelity is low (<99%), suggest increasing iterations or switching solver phases per the
  `/setup` skill
- If the script uses multi-phase solving, report fidelity at each phase transition

## Save between stages

Multi-stage optimization scripts MUST save results after each stage (L-BFGS, Hessian,
min-time, etc.), not just at the end. This prevents losing progress if a later stage fails or
is killed, and lets the user inspect intermediate results.

Pattern:
```julia
# After each solve! call:
timestamp = Dates.format(now(), "yyyymmdd_HHMMSS")
outpath = joinpath(savedir, "$(gate_name)_s$(stage_num)_$(timestamp)")
jldsave(outpath * ".jld2"; pulse = get_pulse(qcp.qtraj))")
println("Saved Stage $stage_num: $(outpath).jld2")
flush(stdout)
```

When writing or reviewing optimization scripts, check that the pulse is saved after
EVERY `solve!` call. If missing, add it.

## Ipopt Output Parsing

Key lines to look for in Ipopt output:
- `Number of Iterations....`: total iterations run
- `Objective..............`: final objective value
- `Overall NLP...........`: CONVERGED or NOT_CONVERGED
- `inf_pr`: primal infeasibility (should be < 1e-6)
- `inf_du`: dual infeasibility

Report after each solve:
```
Iterations: N, Objective: X, inf_pr: Y, Status: Z
Fidelity: F (if available from script output)
```

## Checkpoint Restart

When continuing from a checkpoint:
1. Verify the checkpoint file exists and is non-empty
2. The script should use `load_pulse()` to load the checkpoint
3. Verify initial fidelity matches the saved fidelity (sanity check)
4. If initial fidelity is 0 or NaN, the checkpoint is corrupt — restart from scratch
