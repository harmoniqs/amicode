---
name: transmon
description: Transmon qubit physics, Hamiltonian, drive selection, and Piccolo setup. Use when working on transmon optimization scripts.
agents: [researcher, experimenter]
surface: public
---

Physics reference for transmon qubits in Piccolo optimal control.

## Usage

`/transmon` — reference card for transmon Hamiltonian, parameters, drives, and gates.

The argument is: $ARGUMENTS

## Instructions

When writing or reviewing transmon optimization scripts, use this reference. Provide relevant details from this card when the user asks about transmon physics or when setting up a transmon system.

### Hamiltonian

The transmon is a weakly anharmonic oscillator (Duffing oscillator) in the $E_J \gg E_C$ regime:

$$H_0 = \omega_q\, a^\dagger a + \frac{\alpha}{2}\, a^\dagger a\,(a^\dagger a - 1)$$

- $\omega_q$: qubit ($|0\rangle \to |1\rangle$) transition frequency, typically 4–6 GHz
- $\alpha$: anharmonicity (negative for transmons), typically $-200$ to $-350$ MHz
- $a, a^\dagger$: ladder operators truncated to $n_\mathrm{levels}$ states

Default values: $\omega_q = 5.0$ GHz, $\alpha = -0.3$ GHz ($= -300$ MHz).

### Hardware Variants

| Property | IBM Eagle/Heron | Google Sycamore | Rigetti Ankaa |
|----------|----------------|-----------------|---------------|
| $\omega_q$ | ~5.0 GHz | ~6.0 GHz | ~4.5–5.5 GHz |
| $\alpha$ | ~$-300$ MHz | ~$-200$ MHz | ~$-200$ MHz |
| Frequency | Fixed | Tunable (flux) | Tunable (flux) |
| Native 2Q gate | ECR / CR | $\sqrt{\text{iSWAP}}$ | CZ / iSWAP |
| Coupling | Fixed bus resonator | Direct capacitive | Tunable coupler |
| Typical $T_1$ | 100–300 $\mu$s | 15–30 $\mu$s | 20–50 $\mu$s |

**Default variant**: IBM Eagle/Heron (fixed-frequency, cross-resonance gates, highest coherence).

### Energy Levels

For $\omega_q = 5.0$ GHz, $\alpha = -0.3$ GHz, 4-level truncation:

| Level | Energy (GHz) | Transition freq | Role |
|-------|-------------|-----------------|------|
| $\|0\rangle$ | 0.0 | — | Computational |
| $\|1\rangle$ | 5.0 | $\omega_{01} = 5.0$ GHz | Computational |
| $\|2\rangle$ | 9.7 | $\omega_{12} = 4.7$ GHz | Leakage |
| $\|3\rangle$ | 14.1 | $\omega_{23} = 4.4$ GHz | Leakage |

General formula: $\omega_{n,n+1} = \omega_q + n\alpha$. The $|1\rangle \to |2\rangle$ transition is detuned from the qubit by only $|\alpha| = 300$ MHz — the small anharmonicity ($|\alpha|/\omega_q \approx 6\%$) makes leakage the primary error source.

### Drive Coupling

The transmon is driven via a charge line coupling to the charge operator:

$$\hat{n} = \frac{i}{\sqrt{2}}(a^\dagger - a)$$

Drive Hamiltonian: $H_d(t) = \varepsilon_I(t)\cos(\omega_d t)\,\hat{n} + \varepsilon_Q(t)\sin(\omega_d t)\,\hat{n}$, with $\omega_d \approx \omega_q$. In the rotating frame, $\varepsilon_I(t)$ and $\varepsilon_Q(t)$ are the two independent control channels.

**Matrix elements** (selection rule $\Delta n = \pm 1$, two-photon transitions forbidden):

| Transition | $|\langle m|\hat{n}|n\rangle|$ | Normalized |
|-----------|-------------------------------|-----------|
| $0 \leftrightarrow 1$ | $1/\sqrt{2}$ | 1.0 |
| $1 \leftrightarrow 2$ | $1$ | $\sqrt{2} \approx 1.41$ |
| $2 \leftrightarrow 3$ | $\sqrt{3/2}$ | $\sqrt{3} \approx 1.73$ |
| $0 \leftrightarrow 2$ | 0 | forbidden |

The $|1\rangle \to |2\rangle$ element is $\sqrt{2}$ times larger than $|0\rangle \to |1\rangle$ — the leakage transition is driven harder than the qubit transition at any drive amplitude.

### Leakage Management

Gate targets live in $\{|0\rangle, |1\rangle\}$ but dynamics evolve in the full 4-level space. Use `EmbeddedOperator`:

```julia
op = EmbeddedOperator(GATES[:X], sys)
```

The Pedersen fidelity formula projects the propagator onto the computational subspace. Leakage reduces the projected unitary norm and penalizes leakage without an explicit penalty term. Target $L < 10^{-4}$ for $\mathcal{F} > 99.99\%$.

> **Fidelity convention:** Always report both fixed-phase and free-phase fidelity for multi-subsystem gates. Free-phase is the primary metric. Fixed-phase routinely underreports by 6–80 pp for entangling gates. Ref: [[insight-20260412-054400-synthesis-free-phase-gap-scales-with-gate-type]].

### DRAG Warm-Start

DRAG (Derivative Removal by Adiabatic Gate) cancels leakage to $|2\rangle$ to first order. For a target rotation $R_X(\theta)$ with Gaussian envelope $\Omega(t)$:

$$\varepsilon_I(t) = \Omega(t), \qquad \varepsilon_Q(t) = -\frac{\dot{\Omega}(t)}{\alpha}$$

The $1/\alpha$ factor reflects that smaller anharmonicity requires a larger derivative correction.

**Workflow for Piccolo warm-start:**

1. Construct DRAG pulse analytically at the desired gate duration $T$
2. Sample $\varepsilon_I(t)$, $\varepsilon_Q(t)$ at spline knot points
3. Initialize `SplinePulseProblem` trajectory with these knot values
4. Run L-BFGS to polish beyond DRAG's perturbative accuracy

DRAG alone achieves $\mathcal{F} \approx 99.5$–$99.9\%$; numerical optimization can reach $99.99\%$+.

### Two-Qubit Gates

| Gate | Mechanism | Architecture | Interaction | Typical Duration |
|------|-----------|-------------|-------------|-----------------|
| CNOT (via CR) | Cross-resonance | Fixed-freq (IBM) | $ZX$ | 200–400 ns |
| CZ (via CR) | CR + 1Q rotations | Fixed-freq (IBM) | $ZX$ | 250–500 ns |
| CZ (tunable coupler) | Parametric modulation | Tunable coupler | $ZZ$ | 30–80 ns |
| iSWAP | Resonant exchange | Tunable-freq | $XX + YY$ | 20–50 ns |
| $\sqrt{\text{iSWAP}}$ | Partial exchange | Tunable-freq (Google) | $XX + YY$ | 12–26 ns |

**Cross-resonance (CR)**: Drive control qubit A at target qubit B's frequency. Generates effective $ZX$ interaction through static coupling $J$. Parasitic $IX$, $ZI$, $ZZ$ terms must be cancelled by echo sequences or joint optimal control.

**Always-on ZZ**: Fixed-frequency transmons have a static $ZZ$ coupling $\zeta \approx 2J^2\alpha/(\Delta^2 - \alpha^2)$, typically 50–500 kHz. It accumulates phase during idling and single-qubit gates — a primary motivation for optimal control.

### System Construction

`TransmonSystem` is available in Piccolo.jl (`Piccolo.jl/src/quantum/templates/transmons/transmon_system.jl`). It builds the Duffing Hamiltonian in the rotating frame with two quadrature drives:

```julia
using Piccolo

sys = TransmonSystem(
    ω = 4.0,          # qubit frequency (GHz) — cancels in rotating frame
    δ = 0.2,          # anharmonicity (GHz), positive convention
    levels = 4,       # computational + 2 leakage
    drive_bounds = fill(0.05, 2),  # 50 MHz per quadrature
)
# Drives: [a + a', im*(a - a')] (real + imaginary quadratures)
# multiply_by_2π = true by default (parameters in GHz)

# Embed gate target in computational subspace
op = EmbeddedOperator(:X, sys)
```

For manual construction (e.g., custom drive operators or non-standard frames):

```julia
using Piccolo, LinearAlgebra

n_levels = 4
a = annihilate(n_levels)
H_drift = -δ/2 * a' * a' * a * a  # rotating frame at ω (detuning = 0)
H_drives = [a + a', 1im * (a - a')]
sys = QuantumSystem(2π * H_drift, 2π .* H_drives, [(-0.05, 0.05), (-0.05, 0.05)])
```

Apply energy shift to center the spectrum and reduce ODE stiffness (see Gotchas #5):

```julia
E_mean = tr(H_drift) / n_levels
H_drift_shifted = H_drift - E_mean * I(n_levels)
```

### Gate Targets

All gates embedded in the $n_\mathrm{levels}$-dimensional space (identity on leakage levels):

| Gate | Matrix (computational subspace) |
|------|----------------------------------|
| X | `[0 1; 1 0]` |
| Y | `[0 -im; im 0]` |
| H | `(1/√2)[1 1; 1 -1]` |
| √X | `(1/2)[1+im 1-im; 1-im 1+im]` |
| T | `[1 0; 0 exp(im*π/4)]` |

### Pulse & Problem

**`CubicSplinePulse` + `SplinePulseProblem`.** A microwave AWG oversamples and interpolates
smoothly, and nothing here hard-caps slew — the limit is analog bandwidth. So cubic's 2
DOF/knot (value + Hermite tangent) is the cheaper parameterization, and the fact that a cubic
`du_bound` only constrains slope *at* knots costs nothing, because there is no spec-sheet cap to
certify. Contrast neutral atoms, where the published slew cap forces `LinearSplinePulse` (see
`problem-types` Axis 2).

The physics ceiling on bandwidth is the anharmonicity: spectral content near $|\alpha| =
300$ MHz drives $|1\rangle\to|2\rangle$. That caps useful knots at $N \lesssim 2|\alpha|T + 1$
— for a 20 ns gate, 13.

### Default Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| n_levels | 4 | Qubit + 2 leakage levels |
| Pulse / template | `CubicSplinePulse` / `SplinePulseProblem` | AWG interpolates; no hard slew cap |
| T (initial) | 20 ns (1Q), 300 ns (2Q CR) | At $\Omega_\mathrm{max} = 50$ MHz, $\pi$-pulse takes 10 ns; 20 ns gives margin |
| N_knots | **13** (1Q), **25** (2Q CR) | $N-1 = 12/24$ intervals — the threaded unit |
| Slew ceiling | 21 (1Q) | $T(\text{slew}/u_\text{max})+1 = 20(0.05/0.05)+1$ |
| Bandwidth ceiling | 13 (1Q) | $2|\alpha|T + 1$ — leakage forbids more |
| drive_max | 0.05 GHz (50 MHz) | AWG/mixer linearity limit |
| du_bound | 0.05 GHz/ns | Full-scale swing in ~1 ns; AWG analog bandwidth |
| Δt_bounds | (0.5, 5.0) ns (1Q), (3.8, 38) ns (2Q) | $(0.3, 3.0)\times T/(N-1)$ |
| Q | 100,000 | Infidelity weight |
| R_u | 1e-4 | Amplitude regularization |
| R_du | 1e-5 | Smoothness regularization |

`N = 13` is the binding **bandwidth** ceiling, not a round number: the 1Q slew ceiling is 21,
but leakage caps it at 13 first. `N-1 = 12` balances on 2/3/4/6/12 threads. For 8 threads prefer
`N = 17`, which is still under the slew ceiling but above the leakage-derived bandwidth
ceiling — accept it only if you are separately constraining leakage (see `constraints`).

### Integrator

Use `MagnusAdapt4Alg(tol=1e-8)` for the 4-level system — the eigenvalue spread from $|0\rangle$ to $|3\rangle$ spans ~14 GHz while control dynamics are ~50 MHz, a stiffness ratio of ~280:1. `Tsit5` may suffice for a 3-level system but is not recommended for 4+ levels without energy shift.

### Trajectory Type

`UnitaryTrajectory` — full unitary propagation including leakage levels.

### Gotchas

1. **Frequency crowding in multi-qubit systems.** Fixed-frequency transmon chips must avoid frequency collisions ($\omega_A \approx \omega_B$), two-photon resonances, and $|1\rangle \to |2\rangle$ collisions between neighbors. This is a chip-level constraint affecting which qubit pairs can be CR gate targets.

2. **AC Stark shifts.** Strong drives shift the qubit frequency: $\delta\omega_q = -\Omega^2/(4\alpha)$. At $\Omega = 50$ MHz, $\alpha = -300$ MHz, this is $\approx +2.1$ MHz. DRAG partially compensates; numerical optimization finds the exact correction.

3. **Leakage during cross-resonance.** The CR drive (at $\omega_B$) is detuned from the control qubit's $|1\rangle \to |2\rangle$ transition by $\Delta - \alpha_A$. At high CR amplitude this detuning is insufficient, limiting CR gate speed and requiring 4-level modeling of both qubits.

4. **$n_{12} > n_{01}$.** The $|1\rangle \to |2\rangle$ matrix element is $\sqrt{2}\times$ larger than $|0\rangle \to |1\rangle$. Naive square pulses will always leak — shaped pulses (DRAG or optimized) are essential.

5. **Energy shift with 4+ levels.** Without centering the spectrum the ODE integrator must resolve oscillations at ~14 GHz while controls are ~50 MHz (stiffness ratio ~280:1). Subtract the mean energy from $H_\mathrm{drift}$ before constructing `QuantumSystem`. This is Rule 5 from `/setup`.

6. **Rotating frame conventions.** In the frame rotating at $\omega_d$, the drift acquires a detuning: $(\omega_q - \omega_d)\hat{n}$. Make sure $\omega_d$ in the code matches the intended frame.

7. **Units: GHz and ns.** Energies in GHz (with $\hbar = 1$), times in ns. A drive at $\Omega = 0.05$ GHz corresponds to a $\pi$-pulse Rabi period of $1/(2\Omega) = 10$ ns.

8. **Fixed vs tunable trade-off.** Fixed-frequency (IBM): superior coherence, slow CR gates, always-on ZZ. Tunable-frequency (Google/Rigetti): fast gates, flux noise dephasing. Tunable couplers: ZZ-free idling, added hardware complexity.

### Key Files

- `Piccolo.jl/src/quantum/templates/transmons/transmon_system.jl` — `TransmonSystem`, `MultiTransmonSystem`, `TransmonCavitySystem`
- `transmon-demo/` — demo directory with standard interface (defaults, systems, gates, utils)

Key references:
- Koch et al., *PRA* 76, 042319 (2007) — foundational transmon paper, Duffing approximation
- Motzoi et al., *PRL* 103, 110501 (2009) — DRAG technique
- Sheldon et al., *PRA* 93, 060302(R) (2016) — cross-resonance gate characterization
