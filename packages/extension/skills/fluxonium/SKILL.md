---
name: fluxonium
description: Fluxonium qubit physics, Hamiltonian, drive selection, and Piccolo system setup. Use when working on fluxonium optimization scripts.
agents: [researcher, experimenter]
surface: public
scenarios: [cz-gate-seed]
provides_helpers: [fluxonium_eigenbasis]
---

Physics reference for fluxonium qubits in Piccolo optimal control.

## Usage

`/fluxonium` — reference card for fluxonium Hamiltonian, parameters, drives, and gates.

The argument is: $ARGUMENTS

## Instructions

When writing or reviewing fluxonium optimization scripts, use this reference. Provide relevant details from this card when the user asks about fluxonium physics or when setting up a fluxonium system.

### Hamiltonian

```
H = 4E_C n̂² + ½E_L ϕ̂² - E_J cos(ϕ̂ - ϕ_ext)
```

- n̂: charge number operator
- ϕ̂: phase operator
- ϕ_ext: external flux (operating point)
- Cosine computed via displacement operator identity in Fock basis (n_fock=80)

### Parameter Regimes

| Regime | E_C (GHz) | E_L (GHz) | E_J (GHz) | E_J/E_L | Notes |
|--------|-----------|-----------|-----------|---------|-------|
| **Heavy (default)** | 1.0 | 0.5 | 5.0 | 10 | Protected qubit, low-freq control |
| Light | 1.0 | 1.0 | 3.0 | 3 | Transmon-like, higher freq |
| Ultra-heavy | 0.5 | 0.1 | 8.0 | 80 | Deep wells, extreme nonlinearity |

### Flux Operating Points

| Point | ϕ_ext | ω₀₁ | Characteristics |
|-------|-------|------|-----------------|
| Zero flux | 0 | ~1-2 GHz | Single well, fast transitions |
| Quarter flux | π/2 | intermediate | Moderate control |
| **Half flux** | π | ~0.1 GHz | Double well, **protected qubit**, phase drive 60x stronger than charge |

### Drive Selection

At half-flux, parity breaking makes the phase drive dominant:

```julia
d = fluxonium_eigenbasis(E_C=1.0, E_L=0.5, E_J=5.0, ϕ_ext=π, n_levels=3)
abs(d.ϕ_op[1,2]) / abs(d.n_op[1,2])   # ≈ 59.5 at half-flux — verified, not folklore
```

Build the object with the helper below — **Piccolo ships no fluxonium template**, so this is
yours to write. It is ~15 lines and it is the honest path.

**Always use `:phase` drives at half-flux.** Charge drive alone cannot converge any gate.

| Drive | Operator | Strength at half-flux | When to use |
|-------|----------|----------------------|-------------|
| `:phase` | ϕ̂ (eigenbasis) | Strong (60x) | Default choice |
| `:charge` | n̂ (eigenbasis) | Weak | Avoid at half-flux |
| `:both` | ϕ̂ and n̂ | Both | Research / dual-drive experiments |

### Basis Choice

| | Eigenbasis (recommended) | Fock Basis |
|---|---|---|
| H_drift | Diagonal | Non-diagonal |
| Drive operators | Dense | Tridiagonal (sparse) |
| Target gate | Direct embedding | Requires V transform: U_fock = V * U_eig * V† |
| Use case | Standard optimization | When sparsity matters |

### System Construction

There is **no `FluxoniumSystem` in Piccolo.** Unlike transmons (`TransmonSystem`), ions
(`IonChainSystem`) or Rydberg atoms (`RydbergChainSystem`), fluxonium has no template — you build
it from the Hamiltonian. The code below is the whole thing, and it uses only public API
(`annihilate`, `QuantumSystem`, `EmbeddedOperator`, `GATES`).

```julia
using LinearAlgebra, Piccolo

"""Diagonalise fluxonium in the phase oscillator's Fock basis, then truncate to `n_levels`.
Returns the drift and the drive operators already rotated into the eigenbasis."""
function fluxonium_eigenbasis(; E_C, E_L, E_J, ϕ_ext, n_levels=5, n_fock=80)
    a = annihilate(n_fock)
    ϕ_zpf = (8E_C / E_L)^(1/4) / sqrt(2)      # zero-point spread of the LC mode
    n_zpf = (E_L / (8E_C))^(1/4) / sqrt(2)
    ϕ = ϕ_zpf * (a + a')
    n = im * n_zpf * (a' - a)

    # cos(ϕ̂ - ϕ_ext) from e^{iϕ̂}: expand the shift rather than exponentiating a shifted
    # operator, so ϕ_ext stays a scalar and the matrix exponential is computed once.
    U = exp(im * Matrix(ϕ))
    cosϕ, sinϕ = (U + U') / 2, (U - U') / (2im)
    cos_shift = cos(ϕ_ext) * cosϕ + sin(ϕ_ext) * sinϕ

    H = 4E_C * (n^2) + (E_L / 2) * (ϕ^2) - E_J * cos_shift
    F = eigen(Hermitian(Matrix(H)))
    V = F.vectors[:, 1:n_levels]
    (H_drift  = Diagonal(F.values[1:n_levels] .- F.values[1]),   # energy_shift: ground state to 0
     ϕ_op     = Matrix(V' * ϕ * V),
     n_op     = Matrix(V' * n * V),
     energies = F.values[1:n_levels],
     V        = V)                                              # Fock ↔ eigenbasis transform
end

d = fluxonium_eigenbasis(E_C=1.0, E_L=0.5, E_J=5.0, ϕ_ext=π, n_levels=5)
sys = QuantumSystem(Matrix(d.H_drift), [d.ϕ_op], [0.5])   # phase drive, bound in GHz
```

`QuantumSystem`'s third positional argument is the **drive bounds** and it is required — a
two-argument call is a `MethodError`, not a default.

Subtracting the ground-state energy (`energy_shift`) is not cosmetic: fluxonium's absolute
energies are large compared with ω₀₁, and leaving them in makes the ODE stiff enough to dominate
solve time.

### Gate Targets

All gates are embedded in n_levels-dimensional space (identity on leakage levels):

| Gate | Matrix (computational subspace) |
|------|------|
| X | `[0 1; 1 0]` |
| Y | `[0 -i; i 0]` |
| H | `(1/√2)[1 1; 1 -1]` |
| √X | `(1/2)[1+i 1-i; 1-i 1+i]` |
| T | `[1 0; 0 exp(iπ/4)]` |

```julia
U_goal = EmbeddedOperator(GATES[:X], 1:2, [n_levels])   # identity on the leakage levels
```

`EmbeddedOperator(gate, subspace, levels)` is the real public API. It embeds the 2×2 gate in the
`n_levels`-dimensional space and tells the objective which subspace to score, so leakage is
penalised rather than silently ignored.

> **Fidelity convention:** Always report both fixed-phase and free-phase fidelity for multi-subsystem gates. Free-phase is the primary metric. Fixed-phase routinely underreports by 6–80 pp for entangling gates. Ref: [[insight-20260412-054400-synthesis-free-phase-gap-scales-with-gate-type]].

### Pulse & Problem

**`CubicSplinePulse` + `SplinePulseProblem`.** The flux/charge line is driven by an AWG that
oversamples and interpolates; no spec sheet hard-caps slew here, so cubic's 2 DOF/knot is the
cheaper parameterization (`problem-types` Axis 2).

### Default Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| n_levels | 5 | Qubit + 3 leakage levels |
| n_fock | 80 | Large for accurate diagonalization |
| Pulse / template | `CubicSplinePulse` / `SplinePulseProblem` | AWG interpolates; no hard slew cap |
| T (initial) | **25 ns** | Near the physical optimum. **Not** 50 ns — see below |
| N_knots | **25** | $N-1 = 24$ intervals: balances on 2/3/4/6/8/12 threads |
| Slew ceiling | 26 | $T(\text{slew}/u_\text{max})+1 = 25(0.5/0.5)+1$ — N=25 just fits |
| drive_max | 0.5 GHz | |
| du_bound (slew) | **0.5 GHz/ns** | Full-scale swing in ~1 ns — a real AWG figure |
| Δt_bounds | **(0.31, 3.1) ns** | $(0.3, 3.0)\times T/(N-1)$, nominal 1.04 ns |
| Q | 100,000 | Infidelity weight; try 200,000 for a final push |
| R_u | 1e-4 | Amplitude regularization |
| R_du | 1e-5 | Smoothness regularization |

Three of these changed for reasons worth knowing, because the old values interacted:

- **`du_bound` was 50.0 GHz/ns** — a full 0.5 GHz swing in 10 ps, roughly 100× beyond any AWG.
  It let the optimizer buy fidelity with waveform detail the instrument cannot produce.
- **`T` was 50 ns, labelled "generous, free-time will compress."** It does not compress on its
  own: without `MinimumTimeProblem` the optimizer only nudges timesteps by ~1–3%. Banked runs
  moving `T_init` 50 → 25 ns produced new-best results on **all four** 1Q gates (X, sqrtX, Y, T;
  +0.008 to +0.36 pp) at fixed parameterization. 25 ns is also where the reference results sit.
- **`Δt_bounds` was (0.01, 2.0) ns**, whose upper bound is *below* the nominal step that T=50 ns
  with 11 knots implies (5.0 ns). The stated defaults could not all hold at once.

> **On "linear 51".** Vault notes record linear-51 beating cubic-11 as *universal* for fluxonium
> (+8.23 pp sqrtX, +16.87 pp Y). That comparison moved pulse type and knot count together, and
> 51 knots at T=25 ns is ~2× above the slew ceiling of 26 — it was exploiting the 50 GHz/ns
> `du_bound` above. The best single recorded fluxonium X result is in fact **cubic 21**
> (F = 0.99996). Use cubic 25 as the default; if it stalls, **linear 51 with a physical
> `du_bound` is the documented fallback** — but re-check it against the slew ceiling first.

### Integrator

Use `MagnusAdapt4Alg(tol=1e-8)` — preserves unitarity, handles multi-scale dynamics (slow qubit ~0.1 GHz + fast leakage levels ~5 GHz).

### Trajectory Type

`UnitaryTrajectory` — full unitary propagation including leakage levels.

### Gotchas

1. **Energy shift is essential.** Without it, eigenvalue spread (0 to ~10 GHz for 5 levels) creates stiff ODEs. Always `energy_shift=true`.
2. **Phase drive at half-flux.** Charge drive is 60x weaker — it simply won't converge.
3. **n_fock vs n_levels.** n_fock=80 is for accurate Fock-basis diagonalization. n_levels=5 is the truncated Hilbert space for optimization. Don't confuse them.
4. **Fock basis target gates** need the V transform: `U_fock = V[1:n_levels, 1:n_levels]' * U_eig * V[1:n_levels, 1:n_levels]`.

### Key Files

Reference scripts for this platform live in a standalone `fluxonium-demo` repo. Do not
`include` files from it in an authored script — inline the constants you need so the script
runs against `Piccolo` alone.

- System builders: `src/bases.jl`, `src/systems.jl`
- Gate definitions: `src/gates.jl`
- Defaults: `src/defaults.jl`
- Example scripts: `scripts/eigenbasis/`, `scripts/eigenbasis_cubic/`
