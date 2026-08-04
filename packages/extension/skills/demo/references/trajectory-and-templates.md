# Demo — Trajectory type & system-template selection

How to choose the trajectory type and whether to use a Piccolo system template, plus the
forward-looking roadmap of planned demos. Loaded on demand from [`../SKILL.md`](../SKILL.md).

## Trajectory Type Selection

Choose the trajectory type based on the system's Hilbert space structure:

| System Type | Trajectory | When to use | Example |
|-------------|-----------|-------------|---------|
| Pure qubit (no auxiliary) | `UnitaryTrajectory` | Small Hilbert space, all states are computational | Rydberg atoms (2–8 levels) |
| Qubit + leakage levels | `UnitaryTrajectory` | Moderate leakage (3–5 extra levels), EmbeddedOperator handles subspace | Fluxonium, transmon |
| **Qubit + large auxiliary** | **`MultiKetTrajectory`** | **Large non-computational space; propagate only basis states** | **Trapped ions (qubit⊗phonon), cavity QED** |
| Open system | `DensityTrajectory` | Lindblad master equation, dissipation | Bosonic codes, cat qubits |

**Rule**: When the non-computational subspace is >2x the computational dimension, prefer
`MultiKetTrajectory` over `UnitaryTrajectory`. This avoids propagating DOFs that are never
populated.

**Why it matters**: For a 2-qubit ion gate in a dim-20 composite space (2 qubits × 5 phonon
levels), `UnitaryTrajectory` propagates 20×20 = 400 DOFs. `MultiKetTrajectory` propagates 4
kets × 20 = 80 DOFs — **5x fewer**. The savings grow with auxiliary space size.

**MultiKetTrajectory details**:
- `gates.jl` returns `(initials, goals)` — vectors of kets in the full composite space
- Goal kets enforce auxiliary closure (e.g., phonon returns to vacuum)
- `SplinePulseProblem` auto-dispatches `EnsembleSplineIntegrator` + `CoherentKetInfidelityObjective`
- `MinimumTimeProblem` auto-dispatches `FinalCoherentKetFidelityConstraint`
- Coherent fidelity: `|1/n ∑ᵢ ⟨goal_i|ψ_i(T)⟩|²` ensures all state transfers share a global phase → true gate

## System Template Strategy

When a Piccolo template exists for your hardware platform, **prefer the template** over
building from scratch:

| Template | Module | Use for |
|----------|--------|---------|
| `IonChainSystem` | `Piccolo.jl/src/quantum/templates/ions/ion_chain.jl` | Trapped ions (matrix-based, SplineIntegrator compatible) |
| `TransmonSystem` | `Piccolo.jl/src/quantum/templates/transmons/` | Transmon qubits |
| `CatSystem` | `Piccolo.jl/src/quantum/templates/cats/` | Cat qubits, bosonic codes |
| `TransmonCavitySystem` | `Piccolo.jl/src/quantum/templates/cavities/` | Transmon-cavity systems |

**When a template exists**: Wrap it in `systems.jl` with platform-specific defaults. Return
`(system, metadata)` where metadata holds subsystem info needed by `gates.jl` for state
construction.

**When no template exists** (e.g., fluxonium): Build from scratch in `systems.jl` + optional
`bases.jl` for non-trivial basis construction (diagonalization, truncation, projection).

**Important**: Templates MUST use matrix-based `H_drives` for SplineIntegrator compatibility.
Function-based templates (e.g., `RadialMSGateSystem`) require ODE integrators and are NOT
compatible with the SplinePulseProblem pipeline. Document these as advanced alternatives in
the README.

## Forward-Looking Demo Roadmap

| Demo | System Template | Trajectory Type | Key Pattern |
|------|----------------|-----------------|-------------|
| `atoms` (2-level) | Custom (from scratch) | `UnitaryTrajectory` | Multi-qubit Rydberg, no auxiliary space |
| `atoms` (3-level) | Custom (from scratch) | `UnitaryTrajectory` + `EmbeddedOperator` | Rydberg with leakage, free_phase, Magnus integrator |
| `fluxonium` | Custom + `bases.jl` | `UnitaryTrajectory` | Energy eigenbasis, leakage via EmbeddedOperator |
| `ions` | `IonChainSystem` | `MultiKetTrajectory` | Composite qubit⊗phonon, coherent ket fidelity, motional closure |
| `nv_center` | Custom (from scratch) | `UnitaryTrajectory` | **Custom objective** (filter function), no gate target, DD warm start |
| `transmons` (future) | `TransmonSystem` | `UnitaryTrajectory` | Anharmonic levels, leakage via EmbeddedOperator |
| `bosonic` (future) | `CatSystem` / `TransmonCavitySystem` | `DensityTrajectory` | Open system, Lindblad; `MultiKetTrajectory` also possible for closed approximation |

When scaffolding a new demo, consult this table to choose the right trajectory type and
determine whether a system template is available.
