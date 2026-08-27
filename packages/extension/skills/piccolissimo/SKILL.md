---
name: piccolissimo
description: Piccolissimo.jl usage — the entitled fast-path tier for smooth-pulse problems. Spline-faithful integrators for Piccolo problems, adjoint robustness objectives, Gauss–Newton solver configuration, Magnus algorithm selection, and warm-start idioms. Use when authoring a solve.jl in a Piccolissimo-enabled environment.
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
than the Magnus variants.

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
