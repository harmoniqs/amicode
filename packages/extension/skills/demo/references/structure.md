# Demo — Directory layout, module & script conventions

The standard standalone-demo repo layout, the `src/` module conventions, and the script
conventions. Loaded on demand from [`../SKILL.md`](../SKILL.md).

## Directory Layout

Every demo is a standalone repo (`<system>-demo`) and follows this
structure:

```
<system>-demo/
├── Project.toml          # Julia project (deps: Piccolo, JLD2, etc.)
├── Manifest.toml
├── README.md             # Executive summary, highlights table, getting started
├── run_all.jl            # Master script — runs all gates in a single Julia session
├── src/
│   ├── defaults.jl       # Hardware constants, parameter regimes, optimization defaults
│   ├── systems.jl        # QuantumSystem constructors
│   ├── gates.jl          # Target gate matrices
│   ├── utils.jl          # Control initialization, save/load helpers
│   ├── runners.jl        # Optimization runner functions (run_optimization, run_mintime, etc.)
│   └── bases.jl          # (optional) Basis construction, if non-trivial (e.g., fluxonium eigenbasis)
├── docs/
│   ├── system_model.md       # Physics: Hamiltonian, parameters, basis/drive choices
│   ├── optimization_guide.md # Workflow: pseudocode, constraints, tuning, solver settings
│   ├── results_summary.md    # Results tables, ablations, key findings
│   ├── future_directions.md  # Research extensions, open problems
│   └── problem-details/      # (optional) Deep-dive docs on specific NLP formulations
├── scripts/
│   ├── single_qubit/     # One file per gate: optimize_X.jl, optimize_H.jl, ...
│   ├── two_qubit/        # optimize_CZ.jl, optimize_CX.jl, ...
│   ├── three_qubit/      # optimize_Toffoli.jl, ...
│   ├── three_level/      # (optional) Extended-basis scripts: optimize_CZ_3level.jl, ...
│   └── min_time/         # mintime_X.jl, mintime_CZ.jl, ...
├── data/                 # Saved pulses (.jld2), organized by category
│   ├── single_qubit/
│   ├── two_qubit/
│   └── ...
├── plots/                # Generated plots
└── test/
    └── test_<system>.jl  # TestItem-based test suite (or test_<system>.jl at root)
```

## Module Conventions

### `defaults.jl` — Hardware Constants

Define all physical parameters as module-level constants with a consistent prefix:

```julia
# Atoms example
const RYDBERG_C6 = 862690.0        # MHz·μm⁶
const RYDBERG_DISTANCE = 4.0       # μm
const RYDBERG_RABI_MAX = 15.0      # MHz (2π·Ω)
const RYDBERG_RABI_SLEW = 100.0    # MHz/μs

# Fluxonium example
const FLUX_E_C = 1.0               # GHz
const FLUX_E_L = 0.5               # GHz
const FLUX_E_J = 5.0               # GHz
const FLUX_N_FOCK = 80
const FLUX_N_LEVELS = 5
```

Include optimization defaults (`Q`, `R_u`, `R_du`, etc.) alongside hardware parameters so
scripts stay clean.

### `systems.jl` — System Constructors

Return `QuantumSystem` (or a tuple `(QuantumSystem, metadata)` for systems with non-trivial
basis info):

```julia
# Simple (atoms-style): just returns QuantumSystem
function GlobalRydbergSystem(; N=1)
    # ... build H_drift, H_drives, drive_bounds ...
    return QuantumSystem(H_drift, H_drives, drive_bounds)
end

# Rich (fluxonium-style): returns (QuantumSystem, NamedTuple)
function FluxoniumEigenbasis(; ϕ_ext, n_levels, drives=:phase)
    # ... diagonalize, truncate, project ...
    meta = (; V, energies, ω_01, n_levels, ...)
    return QuantumSystem(H_drift, H_drives, drive_bounds), meta
end
```

Systems MUST use explicit `H_drives` matrices (not function-based `G`) for `SplineIntegrator`
compatibility (see `/setup` Rule 5).

### `gates.jl` — Target Gates

The gate interface depends on the trajectory type (see
[trajectory-and-templates.md](trajectory-and-templates.md)).

**UnitaryTrajectory** — return the target unitary matrix:

```julia
# Atoms (2-level): direct 2×2 or 4×4 matrices
target_X() = ComplexF64[0 1; 1 0]
target_CZ() = diagm(ComplexF64[1, 1, 1, -1])

# Atoms (3-level) / Fluxonium: EmbeddedOperator for subspace gates
function target_CZ_3level(; N=2)
    CZ = diagm(ComplexF64[1, 1, 1, -1])
    subspace = get_subspace_indices(fill(3, N))  # computational indices in 3^N space
    return EmbeddedOperator(CZ, subspace, fill(3, N))
end

# Fluxonium: embed 2×2 gate into n_levels space (identity on leakage)
function target_gate(gate::Symbol, n_levels; basis=:eigenbasis, V=nothing)
    G_2x2 = _gate_matrix(gate)
    U = Matrix{ComplexF64}(I, n_levels, n_levels)
    U[1:2, 1:2] .= G_2x2
    return U
end
```

**EmbeddedOperator** is required when the optimization Hilbert space includes leakage levels
beyond the computational subspace (e.g., 3-level Rydberg atoms, multi-level fluxonium). It
enables Pedersen average fidelity on the computational subspace and is a prerequisite for
`free_phase=true`.

**MultiKetTrajectory** — return `(initials, goals)` ket pairs for computational basis states:

```julia
# Ions: build kets in composite qubit⊗phonon space
function ion_gate_states(gate_matrix, meta)
    subsystem_levels = meta.subsystem_levels
    n_comp = 2^meta.N_ions  # computational basis size
    phonon_vac = reduce(kron, [begin v = zeros(ComplexF64, ml); v[1] = 1.0; v end
                                for ml in subsystem_levels[meta.N_ions+1:end]])
    initials, goals = Vector{ComplexF64}[], Vector{ComplexF64}[]
    for k in 1:n_comp
        ψ_qubit = zeros(ComplexF64, n_comp); ψ_qubit[k] = 1.0
        push!(initials, kron(ψ_qubit, phonon_vac))
        push!(goals, kron(gate_matrix * ψ_qubit, phonon_vac))
    end
    return initials, goals
end
target_CNOT(meta) = ion_gate_states(GATES[:CX], meta)
```

### `utils.jl` — Control Initialization and I/O

Must provide these functions:

```julia
# Linear spline initialization
initialize_controls(n_drives, N_knots, T; scale=0.1) → (u_init, times)

# Cubic spline initialization (if using CubicSplinePulse)
initialize_cubic_controls(n_drives, N_knots, T; scale=0.1) → (u_init, du_init, times)

# Save/load for warm-starting
jldsave(filepath * ".jld2"; pulse = get_pulse(qcp.qtraj))
load_pulse(filepath) → (pulse, metadata_dict)
```

Controls should initialize with small random noise (`scale * randn`), zero at boundaries
(`u[:, 1] = 0`, `u[:, end] = 0`).

### `runners.jl` — Optimization Runners

Provide reusable runner functions that handle the full workflow (build trajectory,
integrator, problem, solve, save):

| Function | Purpose |
|----------|---------|
| `run_optimization(; name, sys, U_goal/initials+goals, T, N_knots, ...)` | Single fidelity pass |
| `run_mintime(; name, sys, U_goal/initials+goals, load_path, ...)` | Min-time from checkpoint |
| `run_mintime_lbfgs(; name, sys, U_goal/initials+goals, load_path, ...)` | Three-phase: L-BFGS + exact Hessian |
| `run_three_phase(; name, sys, U_goal/initials+goals, T, N_knots, ...)` | Full pipeline: fidelity + L-BFGS + Hessian |
| `run_robustness(; name, sys, U_goal, load_path, error_operators, ...)` | Robust control |
| `run_3level_optimization(; name, sys, U_goal, ...)` | 3-level gate with EmbeddedOperator, free_phase, Magnus integrator |
| `run_3level_mintime_lbfgs(; name, sys, U_goal, load_path, ...)` | 3-level min-time with L-BFGS + Hessian |

Runners for `UnitaryTrajectory` take `U_goal`; runners for `MultiKetTrajectory` take
`initials` + `goals` ket vectors instead. The internal build step constructs the appropriate
trajectory type.

All runners should:
- Print a banner with the gate name and system info
- **Print the problem before solving:** use `println(qcp)` to display the built-in DTO
  problem summary (trajectory vars, objective terms with weights, integrators, constraints).
  This catches configuration errors early.
- **Print initial fidelity before solving:** compute `fidelity(qtraj)` (or ODE rollout for
  MultiKetTrajectory) before calling `solve!`. This establishes a baseline.
- **Print pulse summary for warm starts:** show knot value ranges, RMS, and key derived
  quantities (e.g., `|α|` for cavity systems) using `get_knot_values(pulse)`.
- Time the solve and print wall time
- **Print fidelity and pulse summary between solver phases:** when using L-BFGS → Hessian or
  curriculum stages, print diagnostics between each phase so progress is visible.
- Call `save_results` after solving
- Return the fidelity (or problem object for robustness)

## Script Conventions

### Individual Gate Scripts (`scripts/`)

Each script is standalone and runnable:

```julia
# Header comment: gate name, system, method
using Piccolo
using JLD2, Dates, LinearAlgebra, SparseArrays

# Include shared modules via relative paths
include(joinpath(@__DIR__, "..", "..", "src", "defaults.jl"))
include(joinpath(@__DIR__, "..", "..", "src", "systems.jl"))
# ... etc.

# CLI argument for max_iter
max_iter = length(ARGS) > 0 ? parse(Int, ARGS[1]) : 100

# Build → Solve → Save
```

Run with: `cd <system>-demo && julia --project=. scripts/<category>/optimize_<gate>.jl [max_iter]`

### Master Script (`run_all.jl`)

- Includes all `src/` modules once at the top
- Runs gates in logical order (1Q → 2Q → 3Q → min-time → robustness)
- Uses runner functions from `runners.jl` (not inline optimization code)
- Accepts CLI args: `julia --project=. run_all.jl [max_iter] [extra_args...]`
- Prints phase banners and a final summary
