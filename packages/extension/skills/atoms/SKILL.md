---
name: atoms
description: Neutral-atom Rydberg qubit physics, Hamiltonian, register geometry, and Piccolo setup. Use when working on Rydberg atom optimization scripts, gate or analog.
agents: [researcher, experimenter]
surface: public
public_refs: [published-specs]
scenarios: [cz-gate-seed, cz-gate-leakage-constrained, mis-on-aquila, atom-transport-handoff]
vault_contract:
  platform_cards: [rydberg-global]
  tags: [rydberg, gate/CZ]
---

Physics reference for neutral-atom Rydberg qubits in Piccolo optimal control.

## Usage

`/atoms` — reference card for the Rydberg Hamiltonian, register geometry, drives, and gates.

The argument is: $ARGUMENTS

## Instructions

To author or review a neutral-atom optimization script: build the system from the
Hamiltonian below (or `RydbergChainSystem`), then load only the reference file you need.
This card is deliberately thin — the deep material is in `references/` and is loaded on
demand:

- **[references/physics.md](references/physics.md)** — Hamiltonian derivation, the 3-level
  dark-state model, free-phase, the Jandura–Pupillo warm start, the deep-blockade CZ
  worked example, multi-stage schedules.
- **[references/parameters.md](references/parameters.md)** — published hardware parameter
  tables per platform, default optimization parameters, integrator selection.
- **[references/systems-and-gates.md](references/systems-and-gates.md)** — register
  geometries, system construction, gate targets, trajectory types.
- **[references/analog.md](references/analog.md)** — the **analog** register workflow:
  blockade radius, adiabatic detuning ramps, MIS encoding, physicality checks. Read this
  when the user speaks in registers and ramps rather than in gates.
- **[references/gotchas.md](references/gotchas.md)** — edge cases.

When the user asks about Rydberg physics or platform parameters, pull the specifics from
the relevant reference rather than reciting from memory. **Inline the constants you use** —
an authored script must be self-contained and runnable with nothing but `Piccolo`.

## The Hamiltonian — everything else follows from it

For $N$ atoms in the ground–Rydberg basis $\{|g\rangle, |r\rangle\}$, with
$n_i = |r\rangle\langle r|_i$:

$$H(t) = \frac{\Omega(t)}{2}\sum_i \left(\cos\phi\,\sigma^x_i - \sin\phi\,\sigma^y_i\right)
       - \Delta(t)\sum_i n_i
       + \sum_{i<j} \frac{C_6}{|\mathbf{r}_i - \mathbf{r}_j|^6}\, n_i n_j$$

Three facts do all the work: the drive is **global** (one $\Omega$, one $\Delta$ for the
whole register on most hardware); the interaction is **positional** ($1/r^6$, so geometry
*is* a control knob); and $\Omega, \Delta$ are the only time-dependent knobs, which is why
a solved pulse is literally two arrays.

## Core API — the 5 calls, pure public Piccolo

1. **System** — either the shipped template or an explicit build:

   ```julia
   using Piccolo
   # Template: N atoms on a line, global Ωx/Ωy/Δ, 1/r^6 interaction.
   sys = RydbergChainSystem(N = 2, C = 862_690 * 2π, distance = 8.7,
                            ignore_Y_drive = true,        # Ω amplitude + phase in hardware
                            drive_bounds = [15.8 * 2π, 124.0 * 2π])   # [Ω_max, Δ_max]
   ```

   Or build it explicitly when you need a geometry the template does not cover (2-D
   registers, per-atom detuning, the 3-level dark-state model) — see
   references/systems-and-gates.md. Explicit `QuantumSystem(H_drift, H_drives,
   drive_bounds)` is always available and always public.

2. **Target** — `GATES[:X]`, `GATES[:CZ]` for a full-space gate;
   `EmbeddedOperator(GATES[:CZ], subspace, levels)` when the model carries leakage levels
   (the 3-level case).
3. **Pulse** — **`LinearSplinePulse(u_init, times)`**. This hardware consumes *piecewise-linear*
   time series (Braket AHS literally; Pulser via ramps) under hard slew caps, and a linear
   spline's `du` is the constrained inter-knot slope — so `du_bounds` bounds the realized slew
   rate everywhere. Cubic bounds slope only *at* knots and can overshoot between them, so it
   cannot certify the cap. `times` is explicit: `collect(range(0.0, T, length = N))`.
4. **Trajectory** — `UnitaryTrajectory(sys, pulse, U_goal)` for a gate;
   `KetTrajectory(sys, pulse, ψ0, ψ_goal)` for state preparation (the analog case).
5. **Problem + solve** — `SplinePulseProblem(qtraj[, N]; du_bounds, Δt_bounds, …)`. Use the
   **vector** `du_bounds`: Ω and Δ caps differ 8× (250 vs 2000 MHz/µs), and a scalar imposes the
   tighter one on both. Then `solve!(qcp; max_iter = …)` and read `fidelity(qcp)` — **as a claim,
   not a result** (see below).

## Canonical runnable skeleton — 2-atom CZ, self-contained

```julia
using Piccolo
using JLD2, LinearAlgebra, Random
Random.seed!(1234)

# Published ⁸⁷Rb / Aquila-lattice constants, inlined (rad/µs, µs, µm).
const C6    = 862_690 * 2π       # rad/µs · µm⁶
const D_UM  = 8.7                # atom spacing, µm
const Ω_MAX = 15.8 * 2π          # rad/µs
const Δ_MAX = 124.0 * 2π         # rad/µs

sys = RydbergChainSystem(N = 2, C = C6, distance = D_UM,
                         ignore_Y_drive = true,
                         drive_bounds = [Ω_MAX, Δ_MAX])

U_goal = GATES[:CZ]              # native via blockade

const Ω_SLEW = 250.0 * 2π        # rad/µs²  (250 MHz/µs)
const Δ_SLEW = 2000.0 * 2π       # rad/µs²  (2000 MHz/µs)

# Knot budget (references/parameters.md). Slew ceiling N ≤ T·(slew/u_max)+1: Ω is binding at
# 250/15.8 = 15.8/µs → 26.3, so N = 25 fits just under it and N-1 = 24 balances on 4/6/8/12
# threads. At T = 0.4 µs the Ω cap allows only ~7 segments — lengthen T, don't add knots.
T, N   = 1.6, 25                 # µs, knots
times  = collect(range(0.0, T, length = N))
u_init = vcat(fill(π / T, 1, N) .+ 0.05Ω_MAX * randn(1, N),   # Ω near π-area
              0.01Δ_MAX * randn(1, N))                        # Δ ≈ 0
u_init[1, :] .= clamp.(u_init[1, :], 0.05Ω_MAX, 0.95Ω_MAX)
pulse = LinearSplinePulse(u_init, times)     # the basis the hardware executes

Δt_nom = T / (N - 1)             # 0.0667 µs
qtraj  = UnitaryTrajectory(sys, pulse, U_goal)
qcp = SplinePulseProblem(qtraj;
    du_bounds = [Ω_SLEW, Δ_SLEW],            # per-channel: the caps differ 8×
    Δt_bounds = (0.3Δt_nom, 3.0Δt_nom),
    Q = 100.0, R_u = 1e-4, R_du = 1e-5)
solve!(qcp; max_iter = 300)

println("optimizer F = ", fidelity(qcp))   # a CLAIM — verify it below
```

For the deep-blockade 3-level CZ (dark $|0\rangle$, `EmbeddedOperator` target,
`free_phase = true`, multi-stage schedule) see references/physics.md.

## Re-rollout verification (always run after solving)

The transcription the optimizer solves and the ODE that describes the atoms are different
integrators. Only the ODE counts. Save the **pulse**, rebuild from scratch, re-roll:

```julia
pulse_opt = get_pulse(qcp.qtraj)
jldsave("cz.jld2"; pulse = pulse_opt)        # save the pulse, never the trajectory

pulse_chk = load_pulse("cz.jld2")
qtraj_chk = UnitaryTrajectory(sys, pulse_chk, U_goal)   # fresh ODE solve at construction
F = fidelity(qtraj_chk)
@assert isapprox(F, fidelity(qcp); atol = 1e-4) "optimizer/rollout mismatch — report neither"
println("verified F = ", F)
```

For entangling gates report **both** fixed-phase and free-phase fidelity; population plots
are phase-blind and cannot tell a CZ from identity-up-to-phase. The full verification
contract is in the `simulate` skill — invoke it rather than re-deriving.

## Where to go next

- **Analog / register problems** (MIS, adiabatic ramps, "run this on a real array") →
  references/analog.md, then the `pasqal` skill for the device path.
- **Formulation** → `problem-types`; **shaping** → `objectives` / `constraints`;
  **chaining** → `compose`; **seeding** → `warm-start`; **verifying** → `simulate`.
