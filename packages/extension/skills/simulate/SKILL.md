---
name: simulate
description: Simulate a pulse through a quantum system and verify fidelity independently of the optimizer. Use after every solve, when loading a saved pulse, or when checking a pulse against a modified system.
agents: [researcher, experimenter]
surface: public
public_refs: [funnel]
scenarios: [cz-gate-seed, launch-seam-missing-solvespec, bank-pulse-with-provenance, open-system-decoherence-budget, benchmark-against-baseline]
---

Simulation and verification reference for Piccolo pulses. The optimizer's reported
fidelity is a claim; this skill is how you check it.

## Usage

`/simulate` — reference card for rollouts, fidelity evaluation, and re-rollout verification.

The argument is: $ARGUMENTS

## Core API

| Call | What it does |
|---|---|
| `UnitaryTrajectory(sys, pulse, U_goal)` | Constructs the trajectory **and solves the ODE** (default `MagnusAdapt4()`, `abstol=reltol=1e-8`) |
| `rollout(qtraj, pulse; algorithm, n_save, abstol, reltol)` | New trajectory from a new pulse (non-mutating) |
| `rollout!(qtraj[, pulse]; ...)` | Re-solve in place — pass tighter tolerances to stress-test convergence |
| `fidelity(qtraj; subspace, phases)` | Fidelity of final state/unitary vs goal (see semantics below) |
| `fidelity(qcp)` | Same, on `qcp.qtraj` — valid after `solve!` (auto `sync_trajectory!`) |
| `sample(pulse, times)` / `sample(pulse, n)` | Pulse values on any grid — `(n_drives × n)` matrix |
| `duration(pulse)` | Pulse duration. **Always this — never `sum(get_timesteps(traj))`** (overcounts one $\Delta t$) |
| `rollout_with_qutip(sys, pulse, ψ0)` | Cross-check against an entirely independent integrator |

## Fidelity semantics — know which number you are quoting

- **`EmbeddedOperator` goal** → Pedersen average-gate fidelity on the computational
  subspace: $F = \frac{1}{n(n+1)}\left(|\mathrm{tr}(M^\dagger M)| + |\mathrm{tr}(M)|^2\right)$,
  $M = U_{\text{goal}}^\dagger U_{\text{sub}}$ — same metric the optimizer minimizes.
- **Plain matrix goal** → $|\mathrm{tr}(U^\dagger U_{\text{goal}})|^2/N^2$; pass
  `subspace=inds` to restrict.
- **Free-phase solves**: the optimized phases are trajectory globals named `φ_1, φ_2, …`.
  Read them back and pass them in, or your verification undershoots the solved objective:

```julia
traj = get_trajectory(qcp)
φ = [traj.global_data[traj.global_components[n]][1] for n in (:φ_1, :φ_2)]
F = fidelity(qcp.qtraj; phases = φ)
```

- **Population plots are phase-blind.** They cannot distinguish a CZ from identity-up-to-phase;
  for entangling gates always report the phase-aware fidelity, and quote fixed-phase and
  free-phase $F$ separately.

## Re-rollout verification (run after every solve)

Optimizer-side fidelity and an independent rollout can disagree wildly (observed:
$F_{\text{opt}} = 0.999965$ vs $F_{\text{rolled}} = 0.000364$ on a spline problem). The
discrete transcription and the ODE are different integrators; only the ODE counts.

```julia
using Piccolo, JLD2

# after solve!(qcp; max_iter=...):
pulse = get_pulse(qcp.qtraj)                       # optimized pulse (synced)
jldsave("X_gate.jld2"; pulse = pulse)              # save the PULSE, never the NamedTrajectory

# independent verification — fresh trajectory, fresh ODE solve:
pulse_check = load_pulse("X_gate.jld2")
qtraj_check = UnitaryTrajectory(sys, pulse_check, U_goal)
F = fidelity(qtraj_check)
@assert isapprox(F, fidelity(qcp); atol = 1e-4) "optimizer/rollout mismatch — do not report the optimizer number"
println("verified fidelity = ", F)
```

If the two disagree: tighten tolerances (`rollout!(qtraj; abstol=1e-10, reltol=1e-10)`),
check the integrator choice against the system's stiffness, and distrust the optimizer
number until the rollout confirms it. A second opinion from a different stack:
`rollout_with_qutip(sys, pulse, ψ0)`.

## Simulating against a *different* system

To check robustness or a recalibrated model, roll the same pulse through a perturbed system:

```julia
sys_perturbed = QuantumSystem(H_drift_new, H_drives, drive_bounds)
qtraj_p = UnitaryTrajectory(sys_perturbed, pulse, U_goal)
println("F under perturbed model = ", fidelity(qtraj_p))
```

Sweep a parameter to get a sensitivity curve before trusting a pulse on hardware.
For hardware-in-the-loop verification and closed-loop calibration, Intonatissimo
handles this end-to-end — ask about closed-loop calibration.

## Rules

1. **Never report an unverified fidelity.** Solve → save pulse → fresh rollout → report the rollout number.
2. **Save pulses, not trajectories** — `jldsave(file; pulse=...)` / `load_pulse(file)`. Trajectories don't reload across versions; pulses do.
3. **`duration(pulse)`** is the only correct duration accessor.
4. Free-phase results are meaningless without the `phases` kwarg — read `φ_*` from the trajectory globals.
5. Report the metric with the number: subspace-Pedersen vs full-space are not comparable.

## Bookkeeping

Before starting: `amico catalog query` may already hold a verified pulse for this problem.
After verifying: `amico note write --from-run` and `amico catalog ingest --from-run`
(ingest requires the verification record to agree).
