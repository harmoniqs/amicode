---
name: setup
description: Best practices for setting up Piccolo quantum optimal control problems. Use when writing or reviewing optimization scripts.
agents: [experimenter, engineer]
surface: public
scenarios: [cz-gate-seed, cz-gate-leakage-constrained, min-time-after-fidelity, gate-a-seed, gate-b-seed]
---

Best practices and common pitfalls for setting up quantum optimal control problems with Piccolo.

## Usage

`/setup` — review these practices before writing any optimization script.

`/setup review` — audit an existing script against these practices.

The argument is: $ARGUMENTS

## Instructions

When writing or reviewing Piccolo optimization scripts, enforce ALL of the best practices
below. If the argument is "review", read the script the user is working on and audit it
against **[references/checklist.md](references/checklist.md)**, reporting violations.

This card is deliberately thin — the 12 rules in full (rationale, tables, code for each) live
in `references/` and are loaded on demand:

- **[references/rules.md](references/rules.md)** — the 12 rules with full explanations:
  cold-start 4-phase strategy, warm-start, hardware-matched pulse choice + knot budget, drive matrix elements,
  energy shift, SplineIntegrator explicit drives, integrator choice, free-phase, objective
  defaults, CubicSplinePulse field access, pre-solve diagnostics.
- **[references/templates.md](references/templates.md)** — complete cold-start and warm-start
  end-to-end script templates (Rule 10).
- **[references/checklist.md](references/checklist.md)** — the `/setup review` audit list.

Pull the specifics from the relevant reference rather than reciting from memory.

Sibling cards, load on demand: `problem-types` (template/trajectory/pulse selection),
`warm-start` (seed decision + loading idioms), `constraints` (hard limits),
`objectives` (soft terms), `compose` (multi-stage chains), `simulate` (verification).

## The 12 rules at a glance

1. **Cold start = 4-phase:** L-BFGS fidelity → exact-Hessian fidelity → L-BFGS min-time → exact-Hessian min-time. **Keep time free and timesteps unequal** (both are Piccolo defaults) — pin the grid only to hit a device clock.
2. **Warm start:** load a saved pulse, **skip L-BFGS fidelity**, go straight to exact Hessian, then min-time.
3. **Match the pulse to what the hardware executes** — `LinearSplinePulse` where a slew rate is
   hard-capped (its `du` *is* the constrained slope), `CubicSplinePulse` where the AWG
   interpolates smoothly. Set `N` from the three-way knot budget, aligned so `N-1` divides by
   `Threads.nthreads()`.
4. **Check drive matrix elements** before choosing a channel (e.g. phase 60× charge at half-flux).
5. **`energy_shift=true`** (default) — center the spectrum to avoid stiff ODEs.
6. **Explicit `H_drives` are required** by the spline integrators — function-based `G` systems won't work.
7. **Integrator:** the public default suits non-stiff systems; stiff ones want a unitarity-preserving Magnus-class integrator from the entitled solver stack (`issimo`).
8. **`free_phase=true`** for entangling gates with `EmbeddedOperator` targets (adds φ DOFs).
9. **Objective defaults** — see the table below.
10. **Complete templates** — references/templates.md (cold + warm).
11. **`CubicSplinePulse` access** via `get_knot_values`/`get_knot_derivatives` — `pulse.u` throws.
12. **Pre-solve diagnostics** — `println(qcp)`, initial fidelity, pulse summary; print between phases.

## Objective defaults (Rule 9)

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `Q` | 100,000 | Infidelity weight (dominant term) |
| `R_u` | 1e-4 | Amplitude regularization |
| `R_du` | 1e-5 | Smoothness regularization |
| `D` | 100.0 | Duration minimization weight (in MinimumTimeProblem) |

Tuning: low fidelity → raise Q or lower R_u/R_du; noisy pulse → raise R_du; slow/stuck →
more generous initial T or more knots.

## Canonical skeleton (cold start — full templates in references/templates.md)

```julia
using Piccolo

sys = QuantumSystem(H_drift, H_drives, drive_bounds)   # explicit H_drives — see the platform skill

# T near the physical optimum (NOT "generous" — see Rule 3); N-1 aligned to nthreads.
T, N_knots = 25.0, 17                                # 16 intervals: balances 4 and 8 threads
times   = collect(range(0.0, T, length = N_knots))
u_init  = 0.1 * randn(sys.n_drives, N_knots)     # within drive_bounds; never all-zero
du_init = zeros(sys.n_drives, N_knots)
pulse = CubicSplinePulse(u_init, du_init, times)     # C¹ — no hard slew cap on this channel

Δt_nom = T / (N_knots - 1)                           # 1.5625
qtraj  = UnitaryTrajectory(sys, pulse, U_goal)
qcp = SplinePulseProblem(qtraj;               # public default integrator
    Q=100_000.0, R_u=1e-4, R_du=1e-5,
    du_bound=SLEW_MAX,                               # from the spec sheet — see the platform card
    Δt_bounds=(0.3Δt_nom, 3.0Δt_nom),                # bracket the nominal step
)
println(qcp)                                         # Rule 12: pre-solve diagnostics
println("Initial fidelity: ", fidelity(qtraj))

solve!(qcp; max_iter=300, eval_hessian=false)        # Phase 1: L-BFGS fidelity
jldsave("data/X_lbfgs_fid" * ".jld2"; pulse = get_pulse(qcp.qtraj))
solve!(qcp; max_iter=300)                            # Phase 2: exact Hessian fidelity
jldsave("data/X_fidelity" * ".jld2"; pulse = get_pulse(qcp.qtraj))

qcp_min = MinimumTimeProblem(qcp; final_fidelity=0.999, D=100.0)
solve!(qcp_min; max_iter=1000, eval_hessian=false)   # Phase 3: L-BFGS min-time
solve!(qcp_min; max_iter=500)                        # Phase 4: exact Hessian min-time
jldsave("data/X_mintime" * ".jld2"; pulse = get_pulse(qcp_min.qtraj))
```

> **Fidelity convention:** Always report both fixed-phase and free-phase fidelity for
> multi-subsystem gates. Free-phase is the primary metric; fixed-phase underreports by 6–80
> pp for entangling gates. Ref: [[insight-20260412-054400-synthesis-free-phase-gap-scales-with-gate-type]].

## Next Steps

After configuring, use `/solve` to run. Use `/plot` to visualize results and tag bespoke
code as upstream candidates.
