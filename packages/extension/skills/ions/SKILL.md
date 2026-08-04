---
name: ions
description: Trapped-ion qubit physics, Hamiltonian, motional modes, and Piccolo setup. Use when working on trapped-ion optimization scripts.
agents: [researcher, experimenter]
surface: public
scenarios: [cz-gate-seed]
---

Physics reference for trapped-ion qubits in Piccolo optimal control.

## Usage

`/ions` — reference card for trapped-ion Hamiltonian, parameters, drives, and gates.

The argument is: $ARGUMENTS

## Instructions

When writing or reviewing trapped-ion optimization scripts, use this reference. Provide relevant details from this card when the user asks about ion physics or when setting up an ion system.

### Hamiltonian

Qubit + motional modes + Lamb-Dicke coupling:

```
H = Σ_i (ωq/2) σᶻᵢ + Σ_m ωm a†_m a_m + Σ_{i,m} ηᵢₘ [uₓᵢ(t) σˣᵢ + uᵧᵢ(t) σʸᵢ] (a†_m + a_m)
```

- ωq: qubit splitting (hyperfine)
- ωm: motional mode frequency
- ηᵢₘ: Lamb-Dicke parameter (ion i, mode m)
- uₓᵢ, uᵧᵢ: per-ion σx and σy drive amplitudes

### Hardware Parameters (QSCOUT / ¹⁷¹Yb⁺)

| Parameter | Value | Units |
|-----------|-------|-------|
| ωq (qubit) | 12.642812 | GHz |
| ωrx (radial x COM) | 3.8 | MHz |
| ωry (radial y COM) | 4.2 | MHz |
| ωz (axial) | 1.5 | MHz |
| η_base (Lamb-Dicke) | 0.08 | dimensionless |
| Rabi max | 0.0002 | GHz (200 kHz) |
| Slew rate | 0.01 | GHz/μs (**10 MHz/μs** — AOM rise ≈ 20 ns for full scale) |

### Motional Mode Structure

For N ions there are **2N radial modes** (N in x, N in y):

| Mode (N=2) | Frequency | Eigenvector | η scaling |
|-------------|-----------|-------------|-----------|
| x-COM | ωrx = 3.8 MHz | (1, 1)/√2 | η_base / √2 |
| x-tilt | √(ωrx² - ωz²) | (1, -1)/√2 | η_base × √(ωrx/ω_tilt) / √2 |
| y-COM | ωry = 4.2 MHz | (1, 1)/√2 | η_base / √2 |
| y-tilt | √(ωry² - ωz²) | (1, -1)/√2 | η_base × √(ωry/ω_tilt) / √2 |

**Coulomb softening:** tilt mode frequency is √(ωr² - ωz²), not just ωr. The axial frequency directly affects radial mode structure.

### System Construction

```julia
using LinearAlgebra, Piccolo

sys = IonChainSystem(
    N_ions      = 2,
    ion_levels  = 2,                        # qubit levels per ion
    N_modes     = 1,                        # motional modes kept
    mode_levels = 2,                        # Fock truncation per mode — keep small!
    ωq          = 12.642812,                # GHz, qubit splitting
    ωm          = [3.8e-3],                 # GHz, one entry per mode
    η           = reshape([0.08, 0.08], 2, 1),   # N_ions × N_modes, and asserted as such
    drive_bounds = [2e-4, 2e-4, 2e-4, 2e-4],     # GHz — 2 drives (σx, σy) per ion
)
# levels = 8 for this config: 2 ions x 2 levels x 1 mode x 2 Fock levels
```

`η` **must** be an `N_ions × N_modes` matrix — `IonChainSystem` asserts it, so a flat vector is an
`AssertionError` rather than a broadcast surprise. With one mode that means `reshape(..., N, 1)`,
not `[0.08 0.08]`.

The Hilbert space is `ion_levels^N_ions × mode_levels^N_modes`, and `mode_levels` is the dangerous
knob: each extra Fock level multiplies the dimension. Start at 2 and raise it only if the
optimised pulse leaves residual phonon population.

### Gate Targets

Gates act on the **qubit subspace only**; phonon modes must return to vacuum:

| Gate | Native? | Notes |
|------|---------|-------|
| CNOT (`GATES[:CX]`) | No | Requires pulse optimization |
| CZ (`GATES[:CZ]`) | No | Requires pulse optimization |
| √iSWAP (`GATES[:sqrtiSWAP]`) | No | Alternative two-qubit primitive |
| SWAP | No | **No `GATES` key** — build the 4×4 yourself |

**Motional closure:** initial and goal states are |k⟩_qubit ⊗ |00...0⟩_phonon. Any residual phonon excitation reduces fidelity automatically.

> **Fidelity convention:** Always report both fixed-phase and free-phase fidelity for multi-subsystem gates. Free-phase is the primary metric. Fixed-phase routinely underreports by 6–80 pp for entangling gates. Ref: [[insight-20260412-054400-synthesis-free-phase-gap-scales-with-gate-type]].

There is no `target_CNOT` helper — build the ket pairs, which is also where motional closure
becomes explicit rather than assumed:

```julia
vacuum = [1.0 + 0im, 0.0]                      # |0⟩ of the single kept mode
qubit(bits) = ket_from_bitstring(bits)

inits = [kron(qubit(b), vacuum)             for b in ["00", "01", "10", "11"]]
goals = [kron(GATES[:CX] * qubit(b), vacuum) for b in ["00", "01", "10", "11"]]
```

Both sides carry `⊗ |0⟩_phonon`, so any residual motional excitation costs fidelity
automatically — that is the whole mechanism, and it only works because the goal states name the
vacuum too.

**The key is `:CX`, not `:CNOT`.** `GATES` is a NamedTuple whose fields are
`I, X, Y, Z, H, CX, CZ, CCX, CCZ, XI, sqrtiSWAP`; `GATES[:CNOT]` is a `FieldError` at runtime.

### Pulse & Problem

**`LinearSplinePulse` + `SplinePulseProblem`.** AOM amplitude control moves between setpoints on
finite-rise ramps, so a piecewise-linear pulse is the basis the hardware actually plays, and a
linear spline's constrained inter-knot slope makes `du_bound` a real bound on the realized ramp
rate (`problem-types` Axis 2).

Unlike atoms, **slew is not the binding constraint here** — it is enormously loose. With
`slew/u_max = 0.01/2e-4 = 50 /µs`, a 100 µs gate could in principle carry ~5000 segments. What
actually limits the knot count is the **mode structure**: an amplitude-modulated gate needs
enough segments to close the phase-space loop of every mode it touches, which is a handful, not
thousands. So the shape floor governs, and 25 is comfortable for one kept mode.

### Default Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| Pulse / template | `LinearSplinePulse` / `SplinePulseProblem` | AOM setpoint ramps |
| T (initial) | 100 μs | Typical gates 50-200 μs |
| N_knots | **25** | $N-1 = 24$ intervals: balances on 2/3/4/6/8/12 threads |
| Slew ceiling | ~5001 | $T(\text{slew}/u_\text{max})+1$ — not binding; mode structure governs |
| mode_levels | 2 | Per mode Fock truncation |
| Q | 100,000 | Infidelity weight |
| R_u | 1e-4 | Amplitude regularization |
| R_du | 1e-5 | Smoothness regularization |
| du_bound | 0.01 GHz/μs | Slew rate (10 MHz/μs) |
| Δt_bounds | **(1.25, 12.5) μs** | $(0.3, 3.0)\times T/(N-1)$, nominal 4.17 μs |

If the solved pulse leaves residual phonon population, the fix is another mode (`N_modes`) or a
higher `mode_levels` — **not** more knots. Raising `mode_levels` multiplies the Hilbert
dimension, and since `MultiKetTrajectory` costs $2k\,\text{dim}$ per knot, that tightens the
memory ceiling on `N` at the same time.

### Integrator

`SplineIntegrator` with default algorithm. The Hilbert space can be large (2^N × mode_levels^(2N)), so keep mode_levels small.

### Trajectory Type

`MultiKetTrajectory` — propagates multiple initial states (one per computational basis state) to enforce gate action on all inputs simultaneously.

### Gotchas

1. **Hilbert space explosion.** 2N radial modes with Fock truncation: dimension = 2^N × mode_levels^(2N). For N=2, mode_levels=2: dim = 4 × 16 = 64. Keep mode_levels=2 unless you have a specific reason.
2. **MultiKetTrajectory, not UnitaryTrajectory.** Ions use state-based trajectories because the full Hilbert space includes phonons. The gate is defined by mapping computational basis states through the qubit+phonon space.
3. **Phonon vacuum closure is automatic.** Goal states have phonons in |0⟩. Any residual excitation naturally reduces overlap — no explicit phonon constraint needed.
4. **Coulomb softening matters.** Tilt mode frequencies depend on ωz. Getting this wrong shifts the mode spectrum and breaks the Lamb-Dicke calculation.
5. **Units are μs and GHz** with very small drive amplitudes (~200 kHz). Timescales are ~100 μs, much slower than superconducting.
6. **Wider Δt_bounds** than other platforms: (1.25, 12.5) μs reflects the slower dynamics — the
   nominal step is 4.17 μs, thousands of times longer than a transmon's. The bracket is still
   `(0.3, 3.0) × T/(N-1)`; only the scale differs.

### Key Files

**Note:** There is no ions demo repo yet. The file paths below are the layout a future
`ions-demo` repo would follow (see the `demo` skill); nothing here can be `include`d today,
so authored scripts must be self-contained.

- System builder: `src/systems.jl`
- Gate definitions: `src/gates.jl`
- Defaults: `src/defaults.jl`
- Example scripts: `scripts/two_qubit/`, `scripts/min_time/`
