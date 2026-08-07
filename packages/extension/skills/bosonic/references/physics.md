# Bosonic — Physics reference

Deep physics for bosonic / cavity-QED systems: the dispersive Hamiltonian, energy-scale
hierarchy, Hilbert space, and the displaced-frame drive decomposition (4 linear + 7
nonlinear terms). Loaded on demand from [`../SKILL.md`](../SKILL.md).

## Dispersive Hamiltonian (Lab / Rotating Frame)

$$H_{\text{disp}} = \frac{\chi}{2}\hat{a}^\dagger \hat{a} - \chi\,\hat{a}^\dagger \hat{a}\,\hat{q}^\dagger \hat{q} - K_q\,\hat{q}^{\dagger 2}\hat{q}^2 - \chi'\,\hat{q}^\dagger \hat{q}\,\hat{a}^{\dagger 2}\hat{a}^2 - K_c\,\hat{a}^{\dagger 2}\hat{a}^2$$

- $\hat{a}$: cavity mode; $\hat{q}$: transmon mode
- $\chi$: dispersive shift (cross-Kerr coupling)
- $K_q$: transmon self-Kerr (anharmonicity)
- $K_c$: cavity self-Kerr
- $\chi'$: higher-order dispersive shift (zero in current parameters)

The first term $(\chi/2)\hat{a}^\dagger\hat{a}$ is a Lamb shift of the cavity due to the transmon vacuum.

## Parameters

| Parameter | Symbol | Value | Rad·GHz |
|-----------|--------|-------|---------|
| Dispersive shift | $\chi/2\pi$ | 32.8 kHz | $2.061 \times 10^{-4}$ |
| Transmon self-Kerr | $K_q/2\pi$ | 200 MHz | 1.257 |
| Cavity self-Kerr | $K_c/2\pi$ | 3.25 Hz | $2.042 \times 10^{-8}$ |
| Higher-order dispersive | $\chi'/2\pi$ | 0 Hz | 0 |

**Rad·GHz units internally.** Multiply standard kHz/MHz/GHz values by $2\pi$. E.g.,
$\chi/2\pi = 32.8$ kHz $\Rightarrow$ $\chi = 2\pi \times 32.8 \times 10^{-6}$ rad·GHz.

## Energy Scale Hierarchy

$$K_q \gg \Omega_{\max} \gg \chi \gg K_c$$

| Ratio | Value | Implication |
|-------|-------|-------------|
| $K_q / \Omega_{\max}$ | $\approx 20$ | Transmon anharmonicity far exceeds drive strength; leakage to $|f\rangle$ suppressed |
| $\Omega_{\max} / \chi$ | $\approx 306$ | Drives fast vs dispersive interaction; gate time compressible |
| $\chi / K_c$ | $\approx 10{,}000$ | Cavity Kerr negligible on gate timescales |
| $K_q / \chi$ | $\approx 6{,}000$ | **Principal stiffness ratio** — integrator must resolve both scales |

## Hilbert Space

| Subsystem | Levels | Basis |
|-----------|--------|-------|
| Transmon | 3 ($|g\rangle$, $|e\rangle$, $|f\rangle$) | Charge basis, lowest 3 levels |
| Cavity | 10 Fock states ($|0\rangle \ldots |9\rangle$) | Fock (number) basis |
| **Total** | **30** | Transmon $\otimes$ Cavity |

Computational subspace: $\{|g\rangle, |e\rangle\} \otimes \{|0\rangle, \ldots, |N_{\text{Fock}}-1\rangle\}$. For GKP, push $N_{\text{Fock}}$ to 15–25.

## Displaced Frame

### Motivation

The cavity drive in the rotating frame produces coherent state excursions $|\alpha(t)\rangle$ dominating the wavefunction. The displaced frame $D(\alpha) = e^{\alpha\hat{a}^\dagger - \alpha^*\hat{a}}$ factors out this classical motion. Controls become $\alpha_I(t) = \text{Re}(\alpha)$ and $\alpha_Q(t) = \text{Im}(\alpha)$.

### Full Hamiltonian Structure

$$H_{\text{displaced}} = H_{\text{drift}} + H_{\text{linear}}(t) + H_{\text{nonlinear}}(t)$$

The nonlinear dependence on controls is the key distinction from standard qubit problems. Use `NonlinearDrive` with analytical Jacobians (ForwardDiff auto-jac); finite-difference gradients are inaccurate and slow.

### Control Channels

| Channel | Control | Physical Meaning |
|---------|---------|-----------------|
| `transmon_I` | $\Omega_I(t)$ | In-phase transmon microwave drive |
| `transmon_Q` | $\Omega_Q(t)$ | Quadrature transmon microwave drive |
| `cavity_I` | $\alpha_I(t)$ | Real part of cavity displacement |
| `cavity_Q` | $\alpha_Q(t)$ | Imaginary part of cavity displacement |

### 4 Linear Drive Terms

| Control | Operator |
|---------|----------|
| $\Omega_I$ | $X_q = \hat{q} + \hat{q}^\dagger$ |
| $\Omega_Q$ | $P_q = (\hat{q} - \hat{q}^\dagger)/i$ |
| $\alpha_I$ | $\frac{\chi}{2}X_a - \chi X_a \hat{q}^\dagger\hat{q} - 2(\chi'\hat{q}^\dagger\hat{q} + K_c)(\hat{a}^{\dagger 2}\hat{a} + \hat{a}^\dagger\hat{a}^2)$ |
| $\alpha_Q$ | $\frac{\chi}{2}P_a - \chi P_a \hat{q}^\dagger\hat{q} - 2i(\chi'\hat{q}^\dagger\hat{q} + K_c)(\hat{a}^{\dagger 2}\hat{a} - \hat{a}^\dagger\hat{a}^2)$ |

where $X_a = \hat{a} + \hat{a}^\dagger$, $P_a = (\hat{a} - \hat{a}^\dagger)/i$.

### 7 Nonlinear Drive Terms

| Product of Controls | Operator |
|---------------------|----------|
| $|\alpha|^2 = \alpha_I^2 + \alpha_Q^2$ | $\frac{\chi}{2}I - \chi\hat{q}^\dagger\hat{q} - 4(\chi'\hat{q}^\dagger\hat{q} + K_c)\hat{a}^\dagger\hat{a}$ |
| $\alpha_I^2$ | $-(\chi'\hat{q}^\dagger\hat{q} + K_c)(\hat{a}^{\dagger 2} + \hat{a}^2)$ |
| $\alpha_Q^2$ | $+(\chi'\hat{q}^\dagger\hat{q} + K_c)(\hat{a}^{\dagger 2} + \hat{a}^2)$ |
| $\alpha_I \cdot \alpha_Q$ | $-2i(\chi'\hat{q}^\dagger\hat{q} + K_c)(\hat{a}^{\dagger 2} - \hat{a}^2)$ |
| $|\alpha|^2 \cdot \alpha_I$ | $-2(\chi'\hat{q}^\dagger\hat{q} + K_c)X_a$ |
| $|\alpha|^2 \cdot \alpha_Q$ | $-2(\chi'\hat{q}^\dagger\hat{q} + K_c)P_a$ |
| $|\alpha|^4$ | $-\chi'\hat{q}^\dagger\hat{q} - K_c\,I$ |

With $\chi' = 0$: all $(\chi'\hat{q}^\dagger\hat{q} + K_c)$ factors reduce to $K_c \approx 2 \times 10^{-8}$. Tiny but structurally important; keep for correctness.

## System Construction

```julia
using Piccolo

# Parameters (rad·GHz)
chi    = 2π * 32.8e-6   # dispersive shift
K_q    = 2π * 0.200     # transmon self-Kerr
K_c    = 2π * 3.25e-9   # cavity self-Kerr
chi_p  = 0.0            # higher-order dispersive shift

N_transmon = 3
N_fock     = 10

# Build operators — `annihilate(n)` is the public Piccolo primitive.
a = kron(annihilate(N_fock), Matrix(I, N_transmon, N_transmon))   # cavity mode
q = kron(Matrix(I, N_fock, N_fock), annihilate(N_transmon))       # transmon mode
X_a, P_a = (a + a') / 2, im * (a' - a) / 2
X_q, P_q = (q + q') / 2, im * (q' - q) / 2

# Drift Hamiltonian
H_drift = (chi/2)*(a'*a) - chi*(a'*a)*(q'*q) - K_q*(q'^2*q^2) - K_c*(a'^2*a^2)

# Linear drives: 4 terms
linear_drives = [
    LinearDrive(X_q, name=:transmon_I),
    LinearDrive(P_q, name=:transmon_Q),
    LinearDrive(G_aI, name=:cavity_I),   # see alpha_I operator above
    LinearDrive(G_aQ, name=:cavity_Q),   # see alpha_Q operator above
]

# Nonlinear drives: 7 terms (products of alpha_I, alpha_Q)
nonlinear_drives = [
    NonlinearDrive((aI, aQ) -> aI^2 + aQ^2, G_norm2, name=:norm2),
    NonlinearDrive((aI, aQ) -> aI^2,         G_aI2,   name=:aI2),
    NonlinearDrive((aI, aQ) -> aQ^2,         G_aQ2,   name=:aQ2),
    NonlinearDrive((aI, aQ) -> aI*aQ,        G_aIaQ,  name=:aIaQ),
    NonlinearDrive((aI, aQ) -> (aI^2+aQ^2)*aI, G_n2aI, name=:norm2_aI),
    NonlinearDrive((aI, aQ) -> (aI^2+aQ^2)*aQ, G_n2aQ, name=:norm2_aQ),
    NonlinearDrive((aI, aQ) -> (aI^2+aQ^2)^2,  G_n4,   name=:norm4),
]

sys = QuantumSystem(H_drift, [linear_drives..., nonlinear_drives...])
```
