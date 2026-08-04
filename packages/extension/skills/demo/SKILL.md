---
name: demo
description: Guidance for building and running quantum optimization demos (gate synthesis, sensing, custom objectives). Use when creating a new demo or adding gates/scripts to an existing one.
agents: [experimenter, engineer]
surface: public
public_refs: [published-specs]
provides_helpers: [initialize_controls, initialize_cubic_controls, save_results,
                   run_optimization, GlobalRydbergSystem, target_X, _gate_matrix,
                   MyObjective, hessian_structure]
scenarios: [cz-gate-seed, bank-pulse-with-provenance]
---

Guidance for building quantum gate optimization demos. A demo is a **standalone repo per
physical system** (`<system>-demo`) with a fixed module layout, so any demo is legible to
someone who has seen one other demo.

## Usage

`/demo new <system>` — scaffold a new standalone demo repo with the standard module structure.

`/demo add <gate>` — add a new gate optimization script to the current demo.

`/demo review` — audit an existing demo against the conventions.

The argument is: $ARGUMENTS

## Instructions

Building or reviewing a demo means following ALL the conventions in `references/`, derived
from the `atoms` and `fluxonium` demos to keep every demo consistent. This card is
deliberately thin — the deep material is loaded on demand:

- **[references/structure.md](references/structure.md)** — repo directory layout, `src/`
  module conventions (`defaults.jl`, `systems.jl`, `gates.jl`, `utils.jl`, `runners.jl`), the
  runner-function table, and the individual-script + `run_all.jl` conventions.
- **[references/conventions.md](references/conventions.md)** — correctness conventions:
  free-phase, integrator selection, leakage constraint, test conventions.
- **[references/trajectory-and-templates.md](references/trajectory-and-templates.md)** —
  `UnitaryTrajectory` vs `MultiKetTrajectory` vs `DensityTrajectory` selection, Piccolo system
  templates, forward-looking demo roadmap.
- **[references/docs.md](references/docs.md)** — `README.md` + the four `docs/` files
  (`system_model`, `optimization_guide`, `results_summary`, `future_directions`) structure.
- **[references/workflows.md](references/workflows.md)** — step-by-step `/demo new`, `/demo
  add`, `/demo review` procedures, post-solve plotting, autonomous-plan pattern.
- **[references/hardware-grounding.md](references/hardware-grounding.md)** — device-faithful
  demos: the step-0 hardware research (device specs over literature composites), the
  `PLAN.md` design record + handoff pattern, and the stage-0 analytic validation that gates
  all solves. Read this before `/demo new` on a named device.
- **[references/custom-objectives.md](references/custom-objectives.md)** — non-gate demos
  (filter-function / state-prep): custom `AbstractObjective`, bypassing `SplinePulseProblem`,
  the `nv_center` layout.

Cross-skill dependencies:
- **Before writing any optimization code, review `/setup`** — the authoritative best practices
  for Piccolo problem setup (objective weights, min-time strategy, integrator choice). The
  demo conventions govern *structure*; `/setup` governs optimization *correctness*.
- **To run a demo's scripts, use `/solve`**; **to plot after solving, use `/plot`**; **to run
  the underlying package tests, use `/test`** (e.g. `/test Piccolo`).

## Key workflow calls — the demo `src/` API

A demo repo factors reusable logic into `src/` modules so scripts stay thin (full signatures
in references/structure.md):

1. **Constants** — `defaults.jl` defines prefixed hardware constants (`RYDBERG_*`, `FLUX_*`)
   plus optimization defaults (`Q`, `R_u`, `R_du`).
2. **System** — `systems.jl` returns `QuantumSystem` (or `(QuantumSystem, meta)`); MUST use
   explicit `H_drives` matrices for `SplineIntegrator` (`/setup` Rule 5).
3. **Target** — `gates.jl`: `target_*()` unitary / `EmbeddedOperator` for subspace gates /
   `(initials, goals)` kets for `MultiKetTrajectory`.
4. **Init + I/O** — `utils.jl`: `initialize_controls`, `initialize_cubic_controls`,
   `save_results`, `load_pulse`.
5. **Runners** — `runners.jl`: `run_optimization`, `run_mintime`, `run_mintime_lbfgs`,
   `run_three_phase`, `run_robustness`, `run_3level_optimization`, `run_3level_mintime_lbfgs`
   (each prints `println(qcp)` + initial fidelity, times the solve, saves, returns fidelity).
6. **Entry points** — one runnable script per gate under `scripts/<category>/`, and a
   `run_all.jl` master that includes `src/` once and runs gates in order.

## Canonical individual-gate script (`scripts/single_qubit/optimize_X.jl`)

```julia
# Gate: X | System: GlobalRydberg | Method: cold-start fidelity
using Piccolo
using JLD2, Dates, LinearAlgebra, SparseArrays

# Include shared modules via relative paths
include(joinpath(@__DIR__, "..", "..", "src", "defaults.jl"))
include(joinpath(@__DIR__, "..", "..", "src", "systems.jl"))
include(joinpath(@__DIR__, "..", "..", "src", "gates.jl"))
include(joinpath(@__DIR__, "..", "..", "src", "utils.jl"))
include(joinpath(@__DIR__, "..", "..", "src", "runners.jl"))

max_iter = length(ARGS) > 0 ? parse(Int, ARGS[1]) : 100   # CLI arg for max_iter

sys    = GlobalRydbergSystem(N=1)
U_goal = target_X()
fid = run_optimization(; name="X", sys=sys, U_goal=U_goal, T=1.0, N_knots=11,
                         max_iter=max_iter)   # builds traj+integrator+problem, solves, saves
println("fidelity = ", fid)
```

Run with: `cd <system>-demo && julia --project=. scripts/single_qubit/optimize_X.jl [max_iter]`.
For entangling / 3-level gates use `run_3level_optimization` (`EmbeddedOperator`,
`free_phase=true`, Magnus integrator) and report **both** fixed- and free-phase fidelity —
fixed-phase underreports by 6–80 pp (references/conventions.md).

> **Fidelity convention:** Always report both fixed-phase and free-phase fidelity for
> multi-subsystem gates. Free-phase is the primary metric. Ref:
> [[insight-20260412-054400-synthesis-free-phase-gap-scales-with-gate-type]].
