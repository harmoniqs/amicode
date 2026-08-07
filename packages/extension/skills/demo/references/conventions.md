# Demo — Optimization conventions

The correctness conventions every demo must follow: free-phase, integrator selection,
leakage constraint, and test conventions. These complement `/setup` (which governs
optimization correctness in general). Loaded on demand from [`../SKILL.md`](../SKILL.md).

## Free-Phase Convention

Use `free_phase=true` when the target gate is defined only up to single-qubit Z-phases (e.g.,
CZ is equivalent to $(Z(\varphi_1) \otimes Z(\varphi_2)) \cdot \mathrm{CZ}$ because virtual
$R_z$ gates are free on most platforms).

**Requirements:**
- Gate must be an `EmbeddedOperator` (subspace gate in a larger Hilbert space)
- System must have well-defined qubit subspaces (e.g., 3-level Rydberg, multi-level fluxonium)

**In scripts:**
```julia
qcp = SplinePulseProblem(qtraj;
    integrator = integrator,
    Q = 100_000.0, R_u = 1e-4, R_du = 1e-5,
    du_bound = slew_rate,
    Δt_bounds = (0.01, 2.0),
    free_phase = true,  # adds φ_1, φ_2, ... as optimized global variables
)
```

**In runners:** 3-level runners should accept a `free_phase` kwarg (default `true` for
entangling gates, `false` for single-qubit).

**In save/load:** `save_results` must capture global variables (phase values) from the
trajectory. The `utils.jl` pattern:
```julia
global_vars = Dict{String,Float64}()
for (name, indices) in pairs(traj.global_components)
    global_vars[string(name)] = traj.global_data[indices][1]
end
```

**In MinimumTimeProblem:** Free-phase variables are auto-detected by `MinimumTimeProblem` —
no extra configuration needed. The fidelity constraint automatically uses
`FinalUnitaryFidelityConstraint` with the phase-parametric goal.

**Fidelity reporting:** Fixed-phase fidelity can appear artificially low (33–88%) for gates
optimized with `free_phase=true`. Always report free-phase fidelity. Scripts should print
both for transparency.

> **Fidelity convention:** Always report both fixed-phase and free-phase fidelity for
> multi-subsystem gates. Free-phase is the primary metric. Fixed-phase routinely underreports
> by 6–80 pp for entangling gates. Ref:
> [[insight-20260412-054400-synthesis-free-phase-gap-scales-with-gate-type]].

## Integrator Selection Convention

Choose the integrator algorithm based on system stiffness:

| Algorithm | When to use | Example |
|-----------|-------------|---------|
| Default (`Tsit5Alg()`) | Non-stiff dynamics, moderate Hilbert spaces | 2-level Rydberg atoms, trapped ions |
| `MagnusGL4Alg(n_steps=N)` | Stiff dynamics, need unitarity preservation, fixed step budget | Deep-blockade 3-level Rydberg (V/Ω >> 1) |
| `MagnusAdapt4Alg(tol=T)` | Stiff dynamics, automatic step size control | Moderate-blockade 3-level Rydberg, fluxonium |

**Magnus integrators preserve unitarity** by construction (Lie group structure). This matters
for systems with large eigenvalue spread (e.g., 3-level Rydberg with V_nn ~ 1000 MHz
alongside Ω ~ 15 MHz).

**In runners:** 3-level runners should default to `MagnusGL4Alg` or `MagnusAdapt4Alg`. The
algorithm choice should be a runner kwarg for flexibility.

```julia
# 3-level runner pattern
integrator = SplineIntegrator(qtraj, N_knots; alg=MagnusGL4Alg(n_steps=50))
```

**Note:** Sensitivity equations always use Tsit5 internally, regardless of the forward
propagator choice.

## Drive-Amplitude & Unit Validation Convention

Shaped-drive demos must pin the drive-amplitude convention with an analytic check **before
the first solve** (the stage-0 pattern in [hardware-grounding.md](hardware-grounding.md)):

- With $H = (\Omega/2)\,\sigma_x$, a constant drive $\Omega$ gives Rabi cycles at
  $\Omega/2\pi$ — the hardware's quoted Rabi frequency maps 1:1 onto the amplitude. With
  $H = \Omega\,\sigma_x$ the rate doubles. Both conventions appear in the literature;
  mixing them is the most common factor-of-2 bug.
- Validate by landmark: a rectangular reference pulse must hit a known analytic landmark
  (e.g. first chevron peak at the device's measured $\pi/2$ time). A peak at half or double
  the expected time means the convention — not the physics — is wrong.
- An optimizer converges happily around a wrong Hamiltonian; the analytic check is the only
  thing that catches this.

**Amplitude bound shape:** bind what the hardware binds. If the limiting mechanism is total
envelope power (e.g. heating), impose the vector bound
$\Omega_x^2 + \Omega_y^2 \le \Omega_\max^2$ (knot-point constraint), not independent
per-quadrature bounds — per-quadrature bounds allow $\sqrt2\times$ over-power at 45° phase.
If per-quadrature bounds are used as a fallback, report $\max_t\|\Omega(t)\|$ post-solve and
say so in `docs/optimization_guide.md`.

## Leakage Constraint Convention

For systems with leakage levels (3-level atoms, multi-level fluxonium), the
`leakage_constraint` option bounds population outside the computational subspace:

```julia
qcp = SplinePulseProblem(qtraj;
    ...,
    piccolo_options = PiccoloOptions(leakage_constraint=true),
)
```

Use judiciously — leakage constraints can interfere with mechanisms that transiently
populate leakage states (e.g., Rydberg blockade uses |r⟩ excitation). For deep-blockade CZ,
leakage constraints may be unnecessary since blockade physics naturally prevents double |rr⟩
excitation.

## Test Conventions

Tests use `@testitem` blocks (TestItemRunner). Cover:

1. **System construction** — correct Hilbert space dimensions, number of drives
2. **Gate unitarity** — `U'U ≈ I`
3. **Pulse initialization** — correct shapes, zero boundaries
4. **Saved pulse loading** — metadata completeness (fidelity, duration, gate_name, etc.)
5. **Fidelity smoke test** — converge a simple gate in ~50 iterations (≥0.9 for 1Q)
6. **Fidelity from saved data** — load pre-optimized pulse and verify fidelity threshold
