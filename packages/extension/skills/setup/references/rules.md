# Setup — The rules in full

The authoritative best practices for setting up Piccolo optimal-control
problems. Enforce ALL of these when writing or reviewing a script. Loaded on demand from
[`../SKILL.md`](../SKILL.md). The complete cold-start / warm-start templates are in
[templates.md](templates.md); the review checklist is in [checklist.md](checklist.md).

## Rule 1: Cold Start — Four-Phase Strategy

A **cold start** means no prior solution exists. Use L-BFGS first (exploratory, large
steps), then refine with exact Hessian, then compress duration:

1. **Phase 1 — Fidelity, L-BFGS:** Generous T, explore the landscape quickly (300-500 iter, `eval_hessian=false`)
2. **Phase 2 — Fidelity, exact Hessian:** Refine the L-BFGS solution to high fidelity (300-500 iter)
3. **Phase 3 — Min-time, L-BFGS:** Aggressive duration compression (1000-3000 iter). Fidelity drops temporarily — this is expected.
4. **Phase 4 — Min-time, exact Hessian:** Reload L-BFGS checkpoint, refine fidelity in the short-duration basin (500-3000 iter)

L-BFGS takes larger, more exploratory steps that can traverse ridges and saddle points.
Exact Hessian converges precisely but gets stuck in local basins. The L-BFGS→Hessian
pattern (explore then refine) applies to both fidelity and min-time phases.

### Free time and unequal timesteps are the defaults — keep them

Two defaults you should almost never override:

| Setting | Default | Meaning |
|---|---|---|
| Δt | always an optimization variable | there is no `free_time` switch to turn off; problems are free-time by construction |
| `PiccoloOptions(timesteps_all_equal)` | **`false`** | each Δt moves independently |

Free, *unequal* timesteps let the optimizer put duration where the dynamics need it — slow
through an avoided crossing, fast through a flat stretch — at a fixed knot count. That
redistribution is a real degree of freedom, and it is often the one that matters most.

**Pin the grid only to satisfy a device clock**, i.e. `Δt_bounds = (Δt, Δt)` plus
`timesteps_all_equal = true` when emitting to hardware that samples on a fixed grid (see
`pasqal`). Two consequences of pinning, both easy to hit by accident:

- **It makes `MinimumTimeProblem` a no-op.** Duration is $\sum_k \Delta t_k$; if every Δt is
  fixed, there is nothing for the duration objective to move. Never pin a problem you intend to
  chain into min-time.
- **`Δt_bounds = (x, x)` already forces equality**, so adding `timesteps_all_equal = true`
  alongside it is redundant belt-and-braces rather than a second constraint.

Because Δt is free, any initial T is fine for fidelity. But without `MinimumTimeProblem` there
is no duration *objective* — the optimizer only adjusts timesteps marginally (~1-3%) to help
fidelity, so free time is not self-compressing. Use `MinimumTimeProblem` after fidelity
convergence to actually shorten the gate.

```julia
solve!(qcp; max_iter=300, eval_hessian=false)              # Phase 1: L-BFGS fidelity
solve!(qcp; max_iter=300)                                  # Phase 2: exact Hessian fidelity
qcp_min = MinimumTimeProblem(qcp; final_fidelity=0.999, D=100.0)
solve!(qcp_min; max_iter=1000, eval_hessian=false)         # Phase 3: L-BFGS min-time
solve!(qcp_min; max_iter=500)                              # Phase 4: exact Hessian min-time
```

## Rule 2: Warm Start — Skip L-BFGS Fidelity

Always save results and support warm-starting:

```julia
# Save
jldsave("data/gate_name" * ".jld2"; pulse = get_pulse(qcp.qtraj))

# Load and continue
pulse, meta = load_pulse("data/gate_name.jld2")
N_knots = get_knot_count(pulse)
qtraj = UnitaryTrajectory(sys, pulse, U_goal)
# ... rebuild problem and solve
```

**Warm starts skip the L-BFGS fidelity phases.** Since the loaded pulse is already a good
solution, go directly to exact Hessian for any fidelity refinement, then proceed to
min-time:

```julia
pulse, meta = load_pulse("data/X_fidelity.jld2")
# ... rebuild problem from pulse ...
solve!(qcp; max_iter=300)                               # straight to exact Hessian
qcp_min = MinimumTimeProblem(qcp; final_fidelity=0.999, D=100.0)
solve!(qcp_min; max_iter=1000, eval_hessian=false)      # L-BFGS compression
solve!(qcp_min; max_iter=500)                           # Hessian refinement
```

Essential for: continuing from checkpoints, switching fidelity→min-time, refining with
different solver settings, transferring solutions between similar systems.

## Rule 3: Match the Pulse to What the Hardware Executes

Neither spline is universally better. Pick the basis the hardware actually plays:

| Feature | LinearSplinePulse | CubicSplinePulse |
|---------|-------------------|------------------|
| Continuity | C⁰ (kinks at knots) | C¹ (smooth, continuous derivatives) |
| DOFs per knot | 1 (value only) | 2 (value + Hermite tangent) |
| `du` meaning | **Constrained**: `(u[k+1]-u[k])/Δt` | **Independent**: Hermite tangent (free DOF) |
| DerivativeIntegrator | Added automatically | NOT added (tangents are free) |
| Slew guarantee | **Everywhere on the waveform** | **At knots only** — interpolant can overshoot between them |
| Use when | a spec sheet publishes a hard slew cap: neutral atoms (Braket AHS / Pulser ramps), ion AOM setpoint ramps | the AWG oversamples and interpolates; slew limited by analog bandwidth, not a hard cap |

The slew-guarantee row is the whole decision. Because a `DerivativeIntegrator` ties `du` to the
inter-knot slope, bounding `du` on a linear spline bounds the realized slew rate everywhere —
so `du_bound` *is* the published spec number. A cubic spline's `du_bound` constrains only the
tangent at each knot; the Hermite interpolant can exceed it in between, so **a cubic spline
cannot certify a hard slew limit**. Where no hard cap exists, cubic's 2 DOF/knot is the cheaper
parameterization for a given shape.

**Initialization:**
```julia
# Linear
times  = collect(range(0.0, T, length = N_knots))
u_init = 0.1 * randn(sys.n_drives, N_knots)      # within drive_bounds; never all-zero
pulse = LinearSplinePulse(u_init, times)

# Cubic — tangents start at zero, optimizer determines them
times   = collect(range(0.0, T, length = N_knots))
u_init  = 0.1 * randn(sys.n_drives, N_knots)     # within drive_bounds; never all-zero
du_init = zeros(sys.n_drives, N_knots)
pulse = CubicSplinePulse(u_init, du_init, times)
```

**Knot count — three numbers, take the smallest.** The full budget lives in `problem-types`;
in brief: a **shape floor** (13–17 for 1Q, 17–25 for 2Q, 25–33 for 3Q/multi-stage), a **slew
ceiling** `N ≤ T·(slew_max/u_max) + 1`, and a **memory ceiling** (variables ≈ `N × state_dim`,
`state_dim = 2·dim²` for Unitary vs `2·k·dim` for MultiKet). If the floor exceeds the slew
ceiling, lengthen `T` — do not add knots. If it exceeds the memory ceiling, switch Unitary →
MultiKet before cutting `N`.

**Align `N` to your thread count.** Every threaded loop in the solver stack runs over
*intervals*, `Threads.@threads for k = 1:(N-1)`, so choose `N = k·Threads.nthreads() + 1`. The
CPU VJP additionally uses red-black coloring (stride 2), so `(N-1) % (2·nthreads) == 0` is
ideal — but note that coloring is skipped when the problem carries globals, so
**`free_phase=true` makes the VJP serial** and only the integrator/Hessian loops stay threaded.
At 4 or 8 threads, `N ∈ {17, 25, 33}` balances both. Avoid values whose `N-1` factors badly:
`N = 48` gives 47 intervals, a prime, which balances on nothing — prefer 49.

**Duration beats parameterization.** When fidelity stalls, fix `T` first, then warm-start, then
knots. `T` should sit near the physical optimum, not be "generous": on fluxonium 1Q gates,
moving `T_init` 50 ns → 25 ns at fixed parameterization produced new-best results on all four
gates (+0.008 to +0.36 pp). An over-generous `T` enlarges the landscape without adding reach.

> **Historical note.** Vault notes recorded "linear 51 beats cubic 11" for fluxonium as
> *universal*. That comparison changed pulse type and knot count together, and 51 knots at
> T=25 ns sits ~2× above that channel's slew ceiling — it was exploiting a `du_bound` of
> 50 GHz/ns, which no AWG can produce. The best single recorded result on fluxonium X was in
> fact **cubic 21** (F = 0.99996). Treat linear-51 as a documented fallback if cubic stalls,
> not as the default.

## Rule 4: Check Drive Matrix Elements

Before choosing a drive channel, verify the transition matrix elements:

Whatever built your system, inspect the drive operators directly — `sys.H_drives` is the
authority, not the parameter names you passed in:

```julia
for (k, H_d) in enumerate(sys.H_drives)
    println("drive $k: |<0|H_d|1>| = ", abs(H_d[1, 2]))
end
```

A near-zero matrix element between the two levels you are trying to connect means that drive
cannot drive that transition, no matter how long you optimise.

Example: At half-flux fluxonium, phase drive is 60x stronger than charge drive due to
parity selection rules. Charge drive alone cannot converge any gate.

## Rule 5: Energy Shift for Drift Hamiltonian

Always use `energy_shift=true` (default) when building systems. Without it, the eigenvalue
spread (0 to ~10 GHz for 5-level fluxonium) creates stiff ODEs that slow the integrator and
hurt convergence.

The shift centers the spectrum: H̃₀ = H₀ - Ē·I where Ē = (E_max + E_min)/2.

## Rule 6: SplineIntegrator Requires Explicit Drive Matrices

`SplineIntegrator` needs `QuantumSystem(H_drift, H_drives, drive_bounds)` with explicit
drive matrices. Function-based systems (`QuantumSystem(H_drift, G_drives)` where G returns
matrices) produce empty `H_drives` and won't work with `SplineIntegrator`.

## Rule 7: Integrator Choice

| Algorithm | Unitarity | Step Size | Best For |
|-----------|-----------|-----------|----------|
| `Tsit5Alg()` (default) | Not preserved | Adaptive | Non-stiff: 2-level Rydberg atoms, trapped ions |
| `MagnusGL4Alg(n_steps=N)` | Preserved | Fixed (N per interval) | Stiff with known scale: deep-blockade 3-level Rydberg (V/Ω >> 1) |
| `MagnusAdapt4Alg(tol=T)` | Preserved | Adaptive | Stiff with variable scale: fluxonium, moderate-blockade 3-level Rydberg |

**When to use Magnus:** Systems with large eigenvalue spread (e.g., V_nn ~ 1000 MHz
alongside Ω ~ 15 MHz, or fluxonium with qubit ~0.1 GHz + leakage ~5 GHz). Magnus integrators
preserve unitarity by construction (Lie group structure) and handle stiffness better than
Tsit5.

**Note:** Sensitivity equations always use Tsit5 internally, regardless of the forward
propagator choice.

## Rule 8: Free-Phase Optimization

Use `free_phase=true` when the target gate is equivalent up to single-qubit Z-rotations
(which are virtual/free on most platforms):

```julia
qcp = SplinePulseProblem(qtraj;
    integrator = integrator,
    Q = 100_000.0, R_u = 1e-4, R_du = 1e-5,
    du_bound = slew_rate,
    Δt_bounds = (0.3Δt_nom, 3.0Δt_nom),   # Δt_nom = T/(N_knots-1)
    free_phase = true,  # adds φ_1, φ_2, ... global variables
)
```

Cost note: the phase globals put the problem on the `global_dim > 0` path, where the CPU VJP
drops its red-black threading and runs serially (Rule 3). The integrator and Hessian-product
loops stay threaded, so knot/thread alignment still pays — but expect less speedup from extra
threads on a free-phase problem than on a fixed-phase one.

**Requirements:**
- Goal must be an `EmbeddedOperator` (subspace gate in a larger Hilbert space)
- Most common for entangling gates: CZ ~ (Z(φ₁) ⊗ Z(φ₂)) · CZ

**Why it matters:** Without free_phase, the optimizer must match both the entangling
structure AND the exact Z-phases simultaneously. This overconstrains the problem. With
free_phase, the optimizer gets 2 extra DOFs that dramatically smooth the landscape. Example:
moderate-blockade CZ shows ~33-88% fixed-phase fidelity but >99.9% free-phase fidelity.

**MinimumTimeProblem integration:** Free-phase variables are auto-detected — no extra
configuration needed.

**Fidelity reporting:** Always distinguish fixed-phase vs free-phase fidelity. The raw
`fidelity(qtraj)` reports fixed-phase, which is misleadingly low for free-phase-optimized
gates.

> **Fidelity convention:** Always report both fixed-phase and free-phase fidelity for
> multi-subsystem gates. Free-phase is the primary metric. Fixed-phase routinely
> underreports by 6–80 pp for entangling gates. Ref:
> [[insight-20260412-054400-synthesis-free-phase-gap-scales-with-gate-type]].

## Rule 9: Objective Function Defaults

Standard values that work across neutral-atom and superconducting systems:

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `Q` | 100,000 | Infidelity weight (dominant term) |
| `R_u` | 1e-4 | Amplitude regularization |
| `R_du` | 1e-5 | Smoothness regularization |
| `D` | 100.0 | Duration minimization weight (in MinimumTimeProblem) |

Tuning: if fidelity is low, increase Q or reduce R_u/R_du. If pulses are noisy, increase
R_du. If the optimizer is slow, the problem may be over-constrained — retune `T` toward the
physical optimum first (Rule 3), then warm-start, and only then add knots.

## Rule 10: Complete Templates

See [templates.md](templates.md) for the full cold-start (no prior solution) and warm-start
(loading a prior solution) end-to-end script templates.

## Rule 11: CubicSplinePulse Field Access

`CubicSplinePulse` stores the spline interpolant in `pulse.controls` (a `CubicHermiteSpline`),
NOT raw matrices. Use the accessor functions:

```julia
u = get_knot_values(pulse)        # Matrix (n_drives × N_knots) — control values at knots
du = get_knot_derivatives(pulse)  # Matrix (n_drives × N_knots) — Hermite tangents at knots
N_knots = get_knot_count(pulse)   # Number of knot points
t = pulse.controls.t              # Knot times vector

# Other fields
pulse.n_drives      # Number of control channels
pulse.duration      # Total pulse duration
pulse.drive_name    # Symbol (:u by default)
pulse.initial_value # Boundary condition at t=0
pulse.final_value   # Boundary condition at t=T
```

**Common mistake:** `pulse.u` does NOT exist — it will throw a `FieldError`. Always use
`get_knot_values(pulse)`.

**drive_bounds:** `sys.drive_bounds` entries can be either scalars (symmetric: `[-b, b]`) or
tuples (asymmetric: `(lo, hi)`). Handle both:
```julia
bound = sys.drive_bounds[i]
lo, hi = bound isa Tuple ? bound : (-bound, bound)
```

## Rule 12: Pre-Solve Diagnostics

**Always print problem info and starting solution before calling `solve!`.** This helps
catch configuration errors early and establishes a baseline.

### Use built-in display

`QuantumControlProblem` and `DirectTrajOptProblem` have `show` methods that print trajectory,
objective (with weights), dynamics, and constraints:

```julia
qcp = SplinePulseProblem(qtraj; ...)
println(qcp)  # prints system, goal, trajectory vars, objective terms, integrators, constraints
```

This gives you NLP structure (variable count, constraint count, objective weights) for free.

### Print initial fidelity

For warm starts especially, compute and print the starting fidelity before optimization:

```julia
println("Initial fidelity: ", fidelity(qtraj))

# Or for MultiKetTrajectory, build a fresh rollout:
qtraj_init = MultiKetTrajectory(sys, pulse, initials, goals)
println("Initial fidelity: ", fidelity(qtraj_init))
```

### Print pulse summary

For warm starts, print the starting pulse characteristics:

```julia
u = get_knot_values(pulse)
for i in 1:pulse.n_drives
    lo, hi = extrema(u[i, :])
    rms = sqrt(sum(u[i, :].^2) / size(u, 2))
    println("  drive $i: range=[$lo, $hi], rms=$rms")
end
```

### Print between solver phases

When using multi-phase strategies (L-BFGS → Hessian, curriculum stages), print fidelity and
pulse summary between each phase so progress is visible in the log.
