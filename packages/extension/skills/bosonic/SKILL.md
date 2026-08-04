---
name: bosonic
description: Bosonic / cavity-QED physics, displaced-frame Hamiltonian, and Piccolo setup. Use when working on bosonic optimization scripts.
agents: [researcher, experimenter]
surface: public
provides_helpers: [cphase_kets, fock]
scenarios: [wigner-tomography-request, cz-gate-seed]
---

Physics reference for bosonic / cavity-QED systems in Piccolo optimal control.

## Usage

`/bosonic` — reference card for the dispersive Hamiltonian, displaced-frame drives, CPHASE gate, and Piccolo setup.

The argument is: $ARGUMENTS

## Instructions

To author or review a bosonic optimization script: use the core API calls below plus the
canonical skeleton, then load only the reference file you need. This card is deliberately
thin — the deep material is in `references/` and is loaded on demand:

- **[references/physics.md](references/physics.md)** — dispersive Hamiltonian, parameters,
  energy-scale hierarchy, Hilbert space, the displaced frame (4 linear + 7 nonlinear drive
  terms), and the system-construction code.
- **[references/gates.md](references/gates.md)** — CPHASE definition + state-transfer
  formulation, drift warm start ($T=\pi/\chi$), ECD protocol, virtual-Z free phase, gate
  targets.
- **[references/parameters.md](references/parameters.md)** — default optimization
  parameters, integrator choice, trajectory type.
- **[references/gotchas.md](references/gotchas.md)** — 8 edge cases + key files.

When the user asks about bosonic physics or parameters, pull specifics from the relevant
reference rather than reciting from memory.

## Core API — the calls to author a bosonic optimization

1. **System** — build the displaced-frame `QuantumSystem` explicitly: 4 linear + 7 nonlinear
   drive terms from the dispersive Hamiltonian at your $(\chi, K_q, K_c)$. The full
   construction is in references/physics.md; `energy_shift` (centering the spectrum) is not
   optional here — the raw spectrum makes the ODE stiff enough to stall.
2. **Target** — CPHASE via `MultiKetTrajectory`: build `kets_init`/`kets_goal` with
   $|e,n\rangle\to e^{i\varphi n}|e,n\rangle$ (references/gates.md), or GKP via
   `gkp_state_prep_trajectory` (references/gkp-stanford.md).
3. **Pulse** — `times = collect(range(0.0, T, length = N_knots))`;
   `pulse = LinearSplinePulse(u_init, times)`. Linear, not cubic, for a reason specific to this
   platform: the displaced frame carries **11 drives** (4 linear + 7 nonlinear), and cubic's
   second DOF per knot would double an already-large control block on a stiff nonlinear-drive
   problem. The constrained inter-knot slope also keeps every segment inside `du_bound`, which
   is what keeps the displaced-frame expansion valid. Drift warm start: start from **zero drives**
   at $T=\pi/\chi\approx15{,}244$ ns for exact CPHASE($\pi$). This is the one platform where
   a zero-amplitude seed is correct — the drift does the work (see `warm-start` rule 1).
4. **Trajectory + integrator** — `qtraj = MultiKetTrajectory(sys, pulse, kets_init,
   kets_goal)`. The energy-scale ratio $K_q/\chi \approx 6000{:}1$ makes this **stiff**: an
   adaptive Magnus integrator from the entitled solver stack (`issimo`) is the right tool. On
   the public path use the default integrator with short timesteps and tight tolerances, and
   treat the re-rollout check as the acceptance criterion, not a formality.
5. **Problem + solve** — `qcp = SplinePulseProblem(qtraj; Q, R, du_bound, Δt_bounds,
   free_phase=true, initial_phases=[-phi_q, -phi_c])`; `solve!(qcp; max_iter=…)` with the
   **exact Hessian**. Never L-BFGS here: the quasi-Newton approximation destroys feasibility
   on nonlinear drives. This is the documented exception to the cold-start ladder in `setup`.

## Canonical runnable skeleton (CPHASE(π) from drift warm start)

```julia
using Piccolo
using JLD2, LinearAlgebra, SparseArrays

# Build the displaced-frame system inline — references/physics.md gives H_drift and all
# 11 drive terms verbatim. Self-contained on purpose: nothing to `include`; the script
# runs against Piccolo alone.
chi, K_q, K_c = 2π * 32.8e-6, 2π * 0.200, 2π * 3.25e-9   # rad·GHz
N_transmon, N_fock = 3, 10
# ... H_drift + [linear_drives..., nonlinear_drives...] per references/physics.md
sys = QuantumSystem(H_drift, drives)

chi   = 2π * 32.8e-6
T     = π / chi                 # ≈ 15,244 ns — exact CPHASE(π) with zero drives
N_knots = 25                    # N-1 = 24 intervals: balances on 2/3/4/6/8/12 threads
times  = collect(range(0.0, T, length = N_knots))
u_init = 0.1 * randn(sys.n_drives, N_knots)      # within drive_bounds; never all-zero   # zero drives = warm start
pulse = LinearSplinePulse(u_init, times)

kets_init, kets_goal = cphase_kets(π; N_fock=10)                 # |e,n> -> e^{iπn}|e,n>
qtraj      = MultiKetTrajectory(sys, pulse, kets_init, kets_goal)
integrator = SplineIntegrator(qtraj, N_knots; alg=MagnusAdapt4Alg(tol=1e-6))

qcp = SplinePulseProblem(qtraj;
    integrator = integrator,
    Q = 100_000.0, R = 1e-4,
    du_bound = 5.0, Δt_bounds = (190.0, 1905.0),   # (0.3, 3.0) × T/(N-1); nominal 635 ns
    free_phase = true, initial_phases = [-phi_q, -phi_c],   # sign: applied to GOAL
)
solve!(qcp; max_iter=300)       # exact Hessian (default) — do NOT use L-BFGS here
println("free-phase fidelity = ", fidelity(qcp))
jldsave(joinpath(outdir, "CPHASE_pi.jld2"); pulse = get_pulse(qcp.qtraj))
```

For GKP state prep use `curriculum_optimize_gkp(...)` (references/gkp-stanford.md).

## Re-rollout verification (always run after solving)

Optimizer-side fidelity can disagree with an independent rollout. Reload the saved pulse,
rebuild the `MultiKetTrajectory`, and re-roll with `max_iter=0`:

```julia
pulse, meta = load_pulse(path * ".jld2")
qtraj = MultiKetTrajectory(sys, pulse, kets_init, kets_goal)
qcp   = SplinePulseProblem(qtraj;
    integrator = SplineIntegrator(qtraj, get_knot_count(pulse); alg=MagnusAdapt4Alg(tol=1e-6)),
    Q = 100_000.0, R = 1e-4, du_bound = 5.0, Δt_bounds = (190.0, 1905.0),
    free_phase = true, initial_phases = [-phi_q, -phi_c])
solve!(qcp; max_iter=0, print_level=0)
@assert isapprox(fidelity(qcp), meta["fidelity"]; atol=1e-6)   # re-rollout matches
```

Always report **both** fixed-phase and free-phase fidelity — fixed-phase underreports by
6–80 pp for entangling gates (references/gates.md).
