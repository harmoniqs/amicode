---
name: compose
description: Compose Piccolo problems into multi-stage workflows — fidelity→min-time chains, robustness ensembles, cross-parameterization transfer, staged refinement, and post-calibration re-optimization. Use when one solve is a stage in a larger plan.
agents: [researcher, experimenter]
surface: public
provides_helpers: [H_drift]
public_refs: [funnel]
scenarios: [cz-gate-reuse-warm-start, kernel-from-two-gates, min-time-after-fidelity, robustness-parameter-spread, calibration-drift-reoptimize]
---

Real results are chains, not single solves. The unit of composition is always the
**pulse** (never the trajectory): each stage extracts a pulse, the next stage warm-starts
from it, and every stage re-verifies before handing off.

## Usage

`/compose` — composition patterns for multi-stage optimization workflows.

The argument is: $ARGUMENTS

## P1 — Fidelity → minimum time (the standard chain)

```julia
qcp = SplinePulseProblem(qtraj; Q = 100.0)
solve!(qcp; max_iter = 300)                            # stage 1: hit fidelity

# Min-time needs a LOWER floor than the fidelity stage so the duration can actually shrink,
# but keep it derived from the grid: Δt_nom = T/(N-1). Asymmetric on purpose — room to
# compress, not room to wander.
Δt_nom = duration(get_pulse(qcp.qtraj)) / (get_knot_count(get_pulse(qcp.qtraj)) - 1)
mtp = MinimumTimeProblem(qcp; final_fidelity = 0.999, D = 100.0,
                         Δt_bounds = (0.1Δt_nom, 1.5Δt_nom))
solve!(mtp; max_iter = 300)
```

`MinimumTimeProblem` deep-copies the trajectory and constraints from the solved problem —
the chain is implicit. Set `final_fidelity` from stage 1's *verified* fidelity minus
margin, not from the target. Repeated min-time rounds with `free_phase` hit the ±2π
phase wall — unwrap and widen `global_bounds` between rounds (see `warm-start`).

## P2 — Nominal → robust (sampling ensemble)

```julia
systems = [QuantumSystem(H_drift(δ), H_drives, drive_bounds) for δ in (-0.02, 0.0, 0.02)]
sp = SamplingProblem(qcp, systems; weights = [0.25, 0.5, 0.25])
solve!(sp; max_iter = 300)
```

Build the ensemble from measured/estimated parameter spreads. Verify the result against
*each* ensemble member (`simulate` skill, perturbed-system section), and report the worst.

## P3 — Cross-parameterization transfer

Move a solved pulse between parameterizations (e.g. spline design → sample-level waveform
for an AWG, or coarse → fine knots):

```julia
pulse  = get_pulse(qcp.qtraj)                          # stage-1 result
times  = range(0.0, duration(pulse), length = 201)
u      = sample(pulse, times)                          # (n_drives × 201)
pulse2 = ZeroOrderPulse(u, collect(times))             # piecewise-constant version
qtraj2 = UnitaryTrajectory(sys, pulse2, U_goal)
qcp2   = SmoothPulseProblem(qtraj2, length(times))     # re-polish in the new basis
```

Verify the transferred seed *before* re-solving — resampling costs fidelity, and you want
to know how much.

## P4 — Staged refinement

Coarse and cheap first, fine and exact last: few knots → more knots (P3 resampling),
loose tolerances → tight, L-BFGS exploration → exact-Hessian polish (cold starts only),
2-level design → 3-level verification and re-polish on the fuller model. Each stage's
verified pulse is the next stage's warm start; keep `Δt_bounds` and drive bounds
consistent across stages or the seed starts infeasible.

## P5 — Post-calibration re-optimization

When calibration updates the system model (new $\chi$, coupling, detuning — e.g. from
Intonatissimo's closed-loop calibration), don't keep tuning the old pulse on the old
model: rebuild the system at the calibrated parameters and re-optimize **warm-started
from the calibrated pulse**. A warm restart at the corrected model routinely recovers
fidelity that in-place tuning plateaus below.

```julia
sys_cal   = QuantumSystem(H_drift_calibrated, H_drives, drive_bounds)
qtraj_cal = UnitaryTrajectory(sys_cal, pulse_current, U_goal)
qcp_cal   = SplinePulseProblem(qtraj_cal)              # native grid ⇒ exact warm start
solve!(qcp_cal; max_iter = 200)
```

## Rules

1. **Pulses are the interface between stages.** Save each stage (`jldsave(f; pulse=…)`);
   never chain through in-memory trajectories you can't reload.
2. **Verify at every seam** — after each stage AND after each transfer/resample, run the
   re-rollout check (`simulate`). A chain silently amplifies an unverified stage-1 lie.
3. **Fidelity floors are set from verified numbers**, with margin (a `final_fidelity`
   above what stage 1 actually achieved makes the min-time problem infeasible).
4. **One thing moves per stage.** Change parameterization OR duration OR model per hop,
   so a regression is attributable.
5. Record the chain: each stage's note should name its seed (`warm_started_from`) so the
   provenance survives into the catalog.

## Next steps

`warm-start` (the seeding mechanics each hop uses), `problem-types` (per-stage template
choice), `simulate` (the verification every seam requires).

## Bookkeeping

Chains are exactly what the catalog's provenance is for: `amico note write --from-run`
per stage, `amico catalog ingest --from-run` for the final verified pulse, seed lineage
in the note.
