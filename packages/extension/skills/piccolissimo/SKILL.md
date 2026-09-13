---
name: piccolissimo
description: Piccolissimo.jl usage — the entitled fast-path tier for smooth-pulse problems. Spline-faithful integrators for Piccolo problems, matrix-free density routing, full-channel (ECO) objectives, adjoint robustness objectives, Gauss–Newton solver configuration, Magnus algorithm selection, and warm-start idioms. Use when authoring a solve.jl in a Piccolissimo-enabled environment.
surface: entitled
entitlement: issimo
---

# Piccolissimo — usage guide

Piccolissimo is the entitled fast-path tier for smooth-pulse problems: you author
Piccolo problems exactly as usual (`SplinePulseProblem`, `SmoothPulseProblem`,
`UnitaryTrajectory`, …) and plug in Piccolissimo's faster integrators, robustness
objectives, and solver configuration on top. `using Piccolo, Piccolissimo` reaches
both surfaces.

> **Delivery mode (read first).** Piccolissimo requires the **issimo entitlement**.
> It is delivered either as the **HP-mode prebuilt sysimage** or via a
> **private-registry sandbox environment** — it is **NOT in the default provisioned
> solve env**. Recipes in this skill run only in those environments; smoke-test
> signatures in the actual environment before launching.

## Selecting the spline integrator

Loading Piccolissimo registers a `SplineIntegrator` into Piccolo's integrator
registry. In direct problem construction you pass the integrator explicitly:

```julia
using Piccolo, Piccolissimo

sys   = QuantumSystem(H_drift, H_drives, drive_bounds)   # your model, as usual
pulse = CubicSplinePulse(u_init, du_init, times)         # spline pulse
qtraj = UnitaryTrajectory(sys, pulse, U_goal)

N = 50
integrator = SplineIntegrator(qtraj, N)                  # spline-faithful dynamics
qcp = SplinePulseProblem(qtraj, N; integrator = integrator, Q = 100.0, du_bound = 10.0)

solve!(qcp; max_iter = 200, tol = 1e-8)
```

Three facts worth internalizing:

- **Piccolo deliberately has no `:spline` backend of its own.** Passing
  `integrator_type = :spline` to `SplinePulseProblem` errors with instructions;
  the only shipped Piccolo backend is `:pwc` (`BilinearIntegrator`), which models
  the drive as piecewise-constant and ignores `:du` — a spline pulse optimized
  against it is not the pulse its name promises.
- **`global_names` requires this integrator.** Optimizing global variables
  (frequencies, couplings) with `SplinePulseProblem(qtraj, N; global_names = [...])`
  errors unless you pass a globals-aware integrator — the spline integrator above,
  constructed with `global_names = [:ω, ...]`.
- **Algorithm choice is a constructor kwarg.** `SplineIntegrator(qtraj, N;
  alg = Tsit5Alg())` is the default; see the Magnus section below for the other
  algorithms and when to reach for them.

On ket and multiket trajectories the constructor additionally accepts
`exact_hessian` (request the exact second-order sensitivity path where implemented)
and `use_ket_sensitivity` (ket-level sensitivity propagation). Some combinations
error at construction rather than silently falling back — if a requested algorithm
does not support the sensitivity mode you asked for, you will know immediately.

## Matrix-free density routing

`DensityTrajectory` and `MultiDensityTrajectory` spline cells route through the
**matrix-free** backend — two-sided Lindbladian Duhamel sweeps, no dense Jacobian
assembled. Measured on the density state-transfer family: the routed solve reached
J = 0.66 in 35 s where the dense fallback spent 148 s reaching J = 152 (**4.2×
faster at far lower J**); routed MultiDensity J 302.62 → 0.20. Open-system
(Lindbladian) problems are therefore first-class — do NOT assume density means
"slow".

- **Assert the routing, never assume it.** The problem knows whether it carries the
  matrix-free kernels and carries zero dense knot blocks — assert both on the
  constructed problem. A mis-routed cell silently pays the dense path.
- **Pulse-type coverage**: cubic, linear, and smooth spline cells route
  (zero-order convenience constructors are linear-spline-class cells under the
  hood — assert, don't assume); bang-bang constructs and routes too.
- **The bang-bang plateau is family-inherent**: piecewise-constant density
  problems plateau far above the routed-cell J-ratio at ANY budget. That is
  expressivity, not a routing defect — don't burn budget fighting it.

## Open-system cells: two known upstream bugs (verify at authoring time)

1. **The `LinearDissipator` rate field is inert on the density rollout path**
   (Piccolo #337). The supported route is **√γ-prescaling** — put the rates on the
   operators, pre-scaled — and *assert the planted dissipation as REALIZED* (e.g.
   an analytic decay check $P_1(T) \approx e^{-\Gamma_1 T}$), because the naive
   constructor silently produces a unitary rollout.
2. **The `DensityTrajectory` conversion discards the `CubicSplinePulse` endpoint
   pins** (Piccolo #338) — MultiKet and MultiDensity pin them; density didn't.
   Restore the hardware-readiness pins (zero value AND zero derivative at both
   endpoints) via stock `EqualityConstraints` on the problem, or the solved pulse
   loses its clean turn-on/off silently.

## Full-channel optimization (ECO)

`ChannelProcessInfidelityObjective` optimizes the **realized channel** of a cycle
on the `MultiDensity` substrate — the K-basis dual-basis process fidelity
$F_{\text{pro}} = \frac{1}{d^2}\sum_k \langle \mathcal{U}(\tau_k), \Lambda(\rho_k)\rangle_{HS}$.
Two authoring facts: it requires the matrix-free routing above, and the gradient
oracle is rollout-FD (AD through the Duhamel cells is not dual-admissible). Two
hard traps: the objective is wrapped in the $|1-F_{\text{pro}}|$ envelope (the bare
form free-falls on infeasible iterates), and $F_{\text{pro}} \ne F_{\text{avg}}$ —
they differ by $(1-F_{\text{pro}})/(d+1)$; never compare one against a
Pedersen-average bar. Team members: the full dual-basis math and the six measured
traps live in the internal `objectives` skill.

## Robustness objectives

Two public objectives make a pulse robust to parameter error, and one wrapper
composes them into a solvable problem:

- `AdjointRobustnessObjective` — operator-space adjoint sensitivity objective.
- `KetAdjointRobustnessObjective(integrator, error_operators, goal, traj; Q = 1.0)`
  — ket-space variant, constructed from an exponential integrator over a
  `KetTrajectory` (or its multiket sibling over `MultiKetTrajectory` with a vector
  of goals).
- `RobustControlProblem(qcp; kwargs...)` — wraps an existing solved problem to
  minimize error susceptibility subject to a fidelity floor. Deep-copies the
  trajectory and constraints, composes the robustness term with the original
  regularizers, and adds a `FinalUnitaryFidelityConstraint`-style floor — the same
  composition pattern as `MinimumTimeProblem`.

```julia
# qcp: a solved unitary problem (spline- or bilinear-integrated)
rcp = RobustControlProblem(qcp;
    error_operators = [E_detune, E_amp],   # Hermitian error matrices
    sys = sys,                             # REQUIRED when qcp integrates with SplineIntegrator
    final_fidelity = 0.9999,               # fidelity floor constraint
    Q_robustness = 1.0,                    # weight on the robustness term
)
solve!(rcp; max_iter = 200)
```

`keep_infidelity_objective = true` keeps the original infidelity term in the
objective alongside robustness (default `false` — the floor constraint carries
fidelity). `error_operators` are the Hermitian matrices whose susceptibility you
want minimized (e.g. a detuning shift, an amplitude-scale error).

## Gauss–Newton solver configuration

The spline integrator's default second-order mode is Gauss–Newton. Configuration
guidance, all at the `solve!`/constructor level:

- **Iteration caps and tolerances** pass straight through `solve!` as Ipopt
  options: `solve!(qcp; max_iter = 200, tol = 1e-8, constr_viol_tol = 1e-6,
  acceptable_tol = 1e-6)`. `max_iter` 100–300 is the working band for spline
  problems; tighten `tol` when you need the last digit of fidelity.
- **Linear-drive models** (affine drive coefficients — the standard transmon
  bilinear form) are the GN path's home regime: keep the defaults.
- **Nonlinear-drive models** (models with drive coefficients like $|\alpha|^2$
  — dispersive transmon-cavity) converge poorly on the GN spline path. Two
  configuration escapes:
  - `solve!(qcp; eval_hessian = false)` — switches Ipopt to L-BFGS, which
    routinely fixes the stall on these models;
  - or solve the same problem on the exponential integrator, whose second-order
    path is exact for its piecewise-constant controls.
- **Ket/multiket problems** can pass `exact_hessian = true` to the
  `SplineIntegrator` constructor to request the exact second-order sensitivity
  path. The unitary path does not offer this flag.

## Magnus algorithms and substep sizing

The spline integrator's forward-propagation algorithm is a kwarg — these are the
choices and their accuracy knobs:

| Algorithm | Constructor | Accuracy knob |
|---|---|---|
| `Tsit5Alg()` (default) | `Tsit5Alg(; adaptive = true, tol = 1e-6, ode_h = 0.1)` | `tol` (adaptive) / `ode_h` (fixed) |
| `MagnusGL4Alg` | `MagnusGL4Alg(; n_steps = 10, tol = 1e-6)` | `n_steps` — steps per knot interval, the **sole** accuracy knob (`tol` is inert) |
| `MagnusAdapt4Alg` | `MagnusAdapt4Alg(; tol = 1e-6)` | `tol` — adaptive on unitary problems; on ket problems it routes to the fixed-step cell and `tol` is inert (a warning fires — control accuracy via `MagnusGL4Alg(n_steps = …)`) |
| `ChebyshevAlg` | `ChebyshevAlg(; n_sub = :auto, bracket = nothing, …)` | `n_sub = :auto` self-sizes each interval at construction and freezes after; ket-only, matrix-free |

Rule of thumb: keep the default `Tsit5Alg` for ordinary problems; reach for the
Magnus algorithms when stiffness, long gates, or large-$\|H\|$ regimes actually
demand them (e.g. `MagnusGL4Alg(n_steps ≈ 50)` for a deep Rydberg blockade, where
the default under-resolves and optimizer fidelity diverges from a fine re-rollout).
For simple bilinear single-qubit gates the plain path usually converges faster
than the Magnus variants — measured, MagnusGL4 matched the standard path on the
transmon X gate only with added complexity, and a bare low-drive run lost two
nines. Reserve Magnus for the regimes that need it.

For manual substep sizing of the fixed-step cells, two exported diagnostics do
the arithmetic for you: `suggest_n_sub(H_drift, H_drives, bracket, coeff!, Ψ0, Δt;
phase_budget = 2.0, dyn_tol = 1e-8, grad_tol = 1e-6)` returns a substep count for
one interval, and `expl_discretization_error(...; same kwargs, n_sub)` (positional) reports the
estimated discretization error at a given count. Sizing is frozen after
construction — a mid-solve re-size is never silently attempted.

## Warm-start idioms

The pulse round-trips through disk, and a solved problem rehydrates directly:

```julia
# after a solved run — extract and save the optimized pulse
pulse_v2 = CubicSplinePulse(get_trajectory(qcp))   # rehydrate from the solved trajectory
JLD2.jldsave("pulse.jld2"; pulse = pulse_v2, fidelity = 0.9998)

# next script — reload and warm-start
pulse = load_pulse("pulse.jld2")                   # returns the pulse (only the "pulse" key)
qtraj = UnitaryTrajectory(sys, pulse, U_goal)
qcp   = SplinePulseProblem(qtraj)                  # native knot times — best for warm-starting
solve!(qcp; max_iter = 60)
```

- `SplinePulseProblem(qtraj)` with no knot count uses the pulse's **native knot
  times** — the intended warm-start path.
- `CubicSplinePulse(controls, derivatives, times)` builds a spline pulse from raw
  knot data when you have it.
- `load_pulse` returns only the pulse object; bundle metadata (fidelity, gate
  name) with `JLD2.jldsave(...; pulse = ..., fidelity = ...)` at save time.

**State warm-starts beat control-only**: seed the knot STATES on the Lie geodesic
$\exp(s_k \log U_{goal})$ with arbitrary controls via
`set_state_guess!(qcp, states; respect_initial = true)` — knot-1 is checked
loudly, du/s_du re-derived, free-phase θ transferred. Measured (10-seed paired):
better rollout fidelity on 9/10 seeds at **2.5–26× fewer inner-solve HVPs** vs
cold. Two hard rules from the same measurements:

- **Never cap the penalty (ρ_max ≲ 1e3) under an infeasible seed** — feasibility
  starves at the seed's violation level; `adaptive_ρ` + a cap is the measured
  worst case. The default ladder is the safe recipe (see the `altissimo` skill
  for the full ρ-schedule doctrine).
- **Gate on rollout truth only** — the stored-terminal infidelity is gameable
  through infeasible states (measured: stored-E ≈ 1e-3 while rollout-E = 0.667).

## Honesty rails

- **The smoke-budget attractor**: a fidelity plateau measured at a tiny smoke
  budget is a BUDGET artifact, not physics. Near-1 is routine at real budgets
  for these model families — never conclude a fidelity ceiling without
  real-budget evidence.
- **Real-problem surface**: performance and fidelity claims validate on real
  platform problems at real budgets; standardized contrived fixtures are for
  mechanism isolation only.
