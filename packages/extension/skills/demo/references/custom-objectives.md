# Demo — Custom-objective (non-gate) demos

How to build a demo that optimizes something other than gate fidelity (spectral sensitivity,
state prep, measurement contrast). The `nv_center` demo is the canonical example. Loaded on
demand from [`../SKILL.md`](../SKILL.md).

Some demos optimize objectives other than gate fidelity — e.g., spectral sensitivity, state
preparation, or measurement contrast. The `nv_center` demo is the canonical example: it
optimizes a **filter function** $F(\omega)$ instead of unitary infidelity.

## Key Differences from Gate Demos

| Aspect | Gate demo | Custom objective demo |
|--------|-----------|----------------------|
| **Goal** | Target unitary $U_\mathrm{goal}$ | Custom scalar objective |
| **Objective** | `UnitaryInfidelityObjective` (built-in) | Custom `AbstractObjective` subtype |
| **Warm start** | Random or geodesic | Physics-informed (DD sequence, analytic solution) |
| **Problem builder** | `SplinePulseProblem` | Manual `DirectTrajOptProblem` (bypass `SplinePulseProblem`) |
| **UnitaryTrajectory goal** | Target gate matrix | Identity (placeholder — not used in objective) |
| **src/ modules** | `gates.jl` | `objectives.jl`, `pulses.jl` (baseline protocols) |

## Implementing a Custom `AbstractObjective`

The objective must implement four methods from `DirectTrajOpt.Objectives`:

```julia
import Piccolo.DirectTrajOpt.Objectives: objective_value, gradient!, hessian_structure, get_full_hessian

struct MyObjective <: AbstractObjective
    # fields...
end

objective_value(obj::MyObjective, traj::NamedTrajectory)::Float64
gradient!(∇::AbstractVector, obj::MyObjective, traj::NamedTrajectory)::Nothing
hessian_structure(obj::MyObjective, traj::NamedTrajectory)::SparseMatrixCSC
get_full_hessian(obj::MyObjective, traj::NamedTrajectory)::SparseMatrixCSC
```

**Critical**: use `import Piccolo.DirectTrajOpt.Objectives:` (not `import DirectTrajOpt:` or
`import Piccolo:`) to extend the correct functions. DirectTrajOpt is not a direct dependency —
access it through Piccolo's module hierarchy. There is a name collision between
`DirectTrajOpt.Objectives.hessian_structure` and
`DirectTrajOpt.CommonInterface.hessian_structure`; importing from `Objectives` resolves the
ambiguity.

**Gradient validation**: always use `test_objective(obj, traj)` or manual finite differences
before optimization. Per-component comparison (Ũ⃗, Δt, u, du) helps isolate gradient bugs.

**L-BFGS mode**: return `spzeros(Z_dim, Z_dim)` from `hessian_structure` and
`get_full_hessian` to use L-BFGS approximation for the custom objective while other objectives
(regularizers) provide exact Hessians.

## Bypassing `SplinePulseProblem`

`SplinePulseProblem` auto-adds an infidelity objective. For custom objectives, build the
problem manually:

```julia
# 1. Convert trajectory
base_traj = NamedTrajectory(qtraj, N; Δt_bounds=(1e-4, 10.0))
traj = add_control_derivatives(base_traj, 1; control_name=:u)

# 2. Build integrators (same as SplinePulseProblem would)
integrators = AbstractIntegrator[BilinearIntegrator(qtraj, N)]
push!(integrators, DerivativeIntegrator(:u, :du, traj))

# 3. Custom objective + regularization
J = Q * MyObjective(...) + QuadraticRegularizer(:u, traj, R_u) + QuadraticRegularizer(:du, traj, R_du)

# 4. Build problem
prob = DirectTrajOptProblem(traj, J, integrators)
qcp = QuantumControlProblem(qtraj, prob)
solve!(qcp; max_iter=300, eval_hessian=false)
```

## NV Center Demo Structure

The `nv_center` demo follows a modified `src/` layout:

```
src/
├── defaults.jl          # NV_ prefixed constants, Pauli matrices
├── systems.jl           # NVSystem() → QuantumSystem (2-level rotating frame)
├── pulses.jl            # cpmg_pulse(), xy8_pulse() → LinearSplinePulse
├── filter_function.jl   # filter_function(qtraj, ω_range), modulation_function()
├── objectives.jl        # FilterFunctionObjective <: AbstractObjective
├── runners.jl           # FilterFunctionProblem(), run_filter_optimization()
├── utils.jl             # initialize_controls, save_pulse_data, load_pulse
└── plotting.jl          # plot_filter_function, plot_pulse, plot_modulation
```

Note: `gates.jl` is replaced by `pulses.jl` (baseline DD sequences) and `objectives.jl`
(custom objective). `filter_function.jl` provides the validation/analysis function that
operates on `UnitaryTrajectory` objects.
