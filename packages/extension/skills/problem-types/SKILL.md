---
name: problem-types
description: Choose the right Piccolo problem template, trajectory type, and pulse parameterization for a task. Use when starting any new optimization or when a problem seems mis-formulated.
agents: [researcher, experimenter]
surface: public
scenarios: [cz-gate-seed, wigner-tomography-request, mis-on-aquila, robustness-parameter-spread, open-system-decoherence-budget]
---

Every Piccolo problem is three choices: **what evolves** (trajectory type), **how controls
are parameterized** (pulse type), and **which template** assembles them. Pick in that order.

## Usage

`/problem-types` — decision reference for problem formulation.

The argument is: $ARGUMENTS

## Axis 1 — trajectory type (what evolves)

| Type | State | Use when |
|---|---|---|
| `UnitaryTrajectory(sys, pulse, U_goal)` | full propagator | gates; goal is a `Matrix` or `EmbeddedOperator` (subspace targets w/ leakage levels) |
| `KetTrajectory(sys, pulse, ψ0, ψg)` | one state | state prep from a fixed initial state |
| `MultiKetTrajectory` | k states | gate on a large space where $k \ll$ dim (rule of thumb: >2× auxiliary dimensions ⇒ MultiKet beats Unitary); `coherent=true` for gates |
| `DensityTrajectory` | density matrix | open systems / dissipation; cost is $O(\text{dim}^2)$ |

`EmbeddedOperator(op, sys)` embeds a computational-subspace gate in the full system;
fidelity is then the subspace (Pedersen) metric automatically.

## Axis 2 — pulse parameterization

**Pick the basis the hardware actually executes** — a physics constraint, not a style preference:

| Hardware behavior | Pulse | Template |
|---|---|---|
| piecewise-linear segments, or a hard slew cap — atoms (Braket AHS / Pulser ramps), ion AOM ramps | `LinearSplinePulse` | `SplinePulseProblem` |
| oversamples + interpolates; slew limited by analog bandwidth — transmon, fluxonium AWGs | `CubicSplinePulse` | `SplinePulseProblem` |
| truly holds samples (QICK-style sample-level AWG) | `ZeroOrderPulse` | `SmoothPulseProblem`, `BangBangPulseProblem` |

The asymmetry that decides it: `LinearSplinePulse` gets a `DerivativeIntegrator` constraining
`du[k] = (u[k+1]-u[k])/Δt`, so bounding `du` bounds slew **everywhere** and `du_bound` *is* the
spec number. `CubicSplinePulse`'s `du` is a free Hermite tangent bounded only *at* knots, so cubic
**cannot certify a hard slew limit** — but its 2 DOF/knot is cheaper where no cap exists.

Spline pulses carry knots, not steps: access via `get_knot_values/get_knot_derivatives/get_knot_count`
(`pulse.u` throws). `T` is the scalar duration, `N` the knot/timestep count (`N = length(times)`).

## Knot count and bounds — derived, never round numbers

Derivations, worked numbers and failure modes: **[references/knot-budget.md](references/knot-budget.md)**.

- **`N` = smallest of three** — *shape floor* (13–17 1Q, 17–25 2Q, 25–33 3Q/multi-stage), *slew
  ceiling* $N \le T(\text{slew}_{\max}/u_{\max})+1$, *memory ceiling* $\propto N \times
  \text{state\_dim}$. Floor over slew ceiling ⇒ lengthen `T`; over memory ceiling ⇒ switch
  `Unitary` → `MultiKet`, before cutting `N` either way.
- **`N-1` divisible by `Threads.nthreads()`** — the solver threads over knot *intervals*, `k = 1:(N-1)`. At 4/8 threads use `N ∈ {17, 25, 33}`; `N=48` gives 47, prime, balanced on nothing.
- **`du_bounds` (vector) when channels differ**; **`Δt_bounds = (0.3, 3.0) .* T/(N-1)`** — a
  *bracket*: time stays free and Δt unequal (both Piccolo defaults — keep them; a pinned
  `(x, x)` grid is for a device clock only, and makes `MinimumTimeProblem` a no-op).
- **Fidelity stalled ⇒ fix `T` first**, then warm-start, then knots. Weights `Q=100`,
  `R_u=1e-4`, `R_du=1e-5` (see `setup`); platform cards carry all of this derived per provider.

## Axis 3 — problem template

| Template | Signature (key kwargs) | Use when |
|---|---|---|
| `SmoothPulseProblem(qtraj, N; du_bound, ddu_bound=1.0, Q=100.0, R=1e-2, Δt_bounds, constraints, free_phase)` | piecewise-constant + derivative smoothness (adds `du`,`ddu`) | hardware wants sample-level waveforms; QICK-style AWGs |
| `SplinePulseProblem(qtraj[, N_or_times]; du_bound, Q, R, constraints, extra_objectives, free_phase)` | knot-parameterized; omit `N_or_times` to keep the seed grid | default for smooth analog control; fewest variables |
| `BangBangPulseProblem(qtraj, N; …, R_u=0.0)` | zero amplitude-regularization ⇒ bang-bang switching | switching/two-level controls, Trotterized schedules |
| `MinimumTimeProblem(qcp; final_fidelity=0.99, D=100.0, Δt_bounds)` | built **from a solved problem** | shortest gate at a fidelity floor — always after a fidelity solve |
| `SamplingProblem(qcp, systems; weights)` | built **from a solved problem** + system ensemble | robustness to parameter uncertainty |

Integrators: `SplinePulseProblem` defaults to the public `BilinearIntegrator`, which is the
right choice for non-stiff systems and needs no configuration. The entitled solver stack
(entitlement `issimo`) adds an explicit spline integrator with selectable algorithms —
lower initial constraint violation, globals-aware dynamics (required for `global_names` /
`free_phase` globals), and unitarity-preserving Magnus variants for stiff multi-level
systems. Check `amico entitlements` before teaching that path; on the public path, shorten
timesteps and lean on the re-rollout check instead.

## Choosing, in prose

- **A gate on a small closed system** → `UnitaryTrajectory` + `SplinePulseProblem`, pulse per Axis 2.
- **A gate with leakage levels** → same, goal = `EmbeddedOperator`, add leakage handling
  (see the `constraints` skill), `free_phase=true` for entangling targets.
- **State prep** → `KetTrajectory` (or `MultiKetTrajectory` for several transfers at once).
- **Large Hilbert space, few relevant states** → `MultiKetTrajectory` (`coherent=true` for gates).
- **Fast gate** → solve fidelity first, then chain `MinimumTimeProblem` (see `compose`).
- **Uncertain parameters / robustness** → nominal solve, then `SamplingProblem` over an
  ensemble of perturbed systems (see `compose`).

## Free phase — objective-only

`free_phase=true` adds per-qubit phase globals `φ_j` to the **objective**
(`UnitaryFreePhaseInfidelityObjective`); it never enters the Hamiltonian or dynamics.
Requires an `EmbeddedOperator` goal (or `subsystem_levels` for ket problems). Use for
entangling gates where single-qubit Z frames are free in hardware.

## Canonical minimal example (pure Piccolo, self-contained)

```julia
using Piccolo
sys    = QuantumSystem(0.0 * PAULIS.Z, [PAULIS.X, PAULIS.Y], [1.0, 1.0])
U_goal = GATES.X
T, N   = 10.0, 17                            # N-1 = 16 intervals: balances 4 and 8 threads
times   = collect(range(0.0, T, length = N))
u_init  = 0.1 * randn(sys.n_drives, N)       # within drive_bounds; never all-zero
du_init = zeros(sys.n_drives, N)
pulse = CubicSplinePulse(u_init, du_init, times)   # no hard slew cap here ⇒ cubic
qtraj = UnitaryTrajectory(sys, pulse, U_goal)
qcp   = SplinePulseProblem(qtraj;            # no N ⇒ keeps the seed knot grid
    Q = 100.0, R_u = 1e-4, R_du = 1e-5,
    du_bound = 1.0,                          # from the spec sheet, not invented
    Δt_bounds = (0.19, 1.9))                 # (0.3, 3.0) × T/(N-1), nominal 0.625
solve!(qcp; max_iter = 100)
println("optimizer F = ", fidelity(qcp))     # then verify — see `simulate`
```

Build the spline explicitly: the 3-argument `UnitaryTrajectory(sys, U_goal, T)` seeds a
`ZeroOrderPulse`, which pairs with `SmoothPulseProblem` — `SplinePulseProblem` is typed on
`{<:AbstractSplinePulse}` and rejects it.

## Next steps

`warm-start` (seed it), `constraints` / `objectives` (shape it), `compose` (chain it),
`simulate` (verify it), and the platform skill (`atoms`/`transmon`/`bosonic`/`ions`/`fluxonium`)
for physics-accurate systems and parameters.
