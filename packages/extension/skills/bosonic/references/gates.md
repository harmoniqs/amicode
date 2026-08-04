# Bosonic — Gates, warm starts & free phase

The CPHASE gate, its state-transfer formulation, the drift warm start, the ECD protocol,
virtual-Z free-phase optimization, and the gate-target table. Loaded on demand from
[`../SKILL.md`](../SKILL.md).

## CPHASE Gate

### Definition

$$\text{CPHASE}(\varphi) = |g\rangle\langle g| \otimes I_{\text{cav}} + |e\rangle\langle e| \otimes e^{i\varphi\hat{n}}$$

Applies a photon-number-dependent phase $e^{i\varphi n}$ to the cavity conditioned on the transmon in $|e\rangle$. At $\varphi = \pi$: conditional parity gate.

### State Transfer Formulation

Encoded as `MultiKetTrajectory` with $2 \times N_{\text{Fock}}$ state pairs:

$$|g, n\rangle \to |g, n\rangle, \qquad |e, n\rangle \to e^{i\varphi n}|e, n\rangle$$

for $n = 0, 1, \ldots, N_{\text{Fock}} - 1$. Avoids constructing the full $30 \times 30$ unitary.

Piccolo exports no `fock` — write it, it is one line:

```julia
fock(n, N) = (v = zeros(ComplexF64, N); v[n + 1] = 1.0; v)   # |n⟩ in an N-level mode

g_state, e_state = [1.0 + 0im, 0.0], [0.0 + 0im, 1.0]

# vcat of TWO comprehensions, not one comprehension with two clauses: `[a for n in r, b for
# n in r]` is not valid Julia, and a 2-D comprehension would not give you a list of kets.
kets_init = vcat([kron(g_state, fock(n, N_fock))                    for n in 0:N_fock-1],
                 [kron(e_state, fock(n, N_fock))                    for n in 0:N_fock-1])

kets_goal = vcat([kron(g_state, fock(n, N_fock))                    for n in 0:N_fock-1],
                 [kron(e_state, exp(im * phi * n) * fock(n, N_fock)) for n in 0:N_fock-1])

qtraj = MultiKetTrajectory(sys, pulse, kets_init, kets_goal)
```

Sanity check before you spend a solve: `length(kets_init) == 2 * N_fock`, every ket has unit norm,
and at `phi = π` the goal amplitude on `|e, 1⟩` is `-1`. If the phase is not showing up, the
`exp(im * phi * n)` factor is on the wrong ket.

## Drift Warm Start

The dispersive interaction $-\chi\hat{a}^\dagger\hat{a}\hat{q}^\dagger\hat{q}$ accumulates phase at rate $-\chi n$ on $|e,n\rangle$. With **zero drives**, at $T_{\text{drift}} = \pi/\chi$:

$$T_{\text{drift}} = \frac{\pi}{\chi} = \frac{\pi}{2\pi \times 32.8\;\text{kHz}} \approx 15{,}244\;\text{ns} \approx 15.2\;\mu\text{s}$$

This gives exact CPHASE($\pi$) with $F_{\text{free}} \approx 99.99\%$ — **a perfect warm start before any optimization**. CPHASE($\pi/2$) uses $T = \pi/(2\chi)$.

## ECD Protocol

The Echoed Conditional Displacement protocol (Eickbusch et al., *Nature Physics* 18, 1464, 2022):

$$U = D(\beta_{N+1}/2) \cdot R_{N+1} \cdot \text{ECD}(\beta_N) \cdot R_N \cdots \text{ECD}(\beta_1) \cdot R_1$$

where $\text{ECD}(\beta) = D(\beta/2)|e\rangle\langle e| + D(-\beta/2)|g\rangle\langle g|$. Implemented in `ECDWarmStarts.jl` with analytic adjoint gradients. CPHASE($\pi$) with 5 ECD blocks: $F = 0.344$ (fixed phase) $\to F > 0.999$ (free phase). ECD circuits work at the circuit level but do **not** directly map to displaced-frame drives (see gotcha 6 in [gotchas.md](gotchas.md)).

## Virtual-Z Free Phase

The cavity supports a free frame rotation $e^{i\phi_1 \hat{n}}$ analogous to virtual-Z gates. In optimization:

$$F = \max_{\phi_1} \frac{|\sum_n e^{i\phi_1 n} o_n|^2}{M^2}$$

found by grid search + Newton refinement. By the envelope theorem, no need to differentiate through the $\phi_1$ optimization.

**Sign convention**: Piccolo applies $\Phi(\theta)$ to the *goal* state. Set `initial_phases = [-phi_q, -phi_c]` to target specific phases.

> **Fidelity convention:** Always report both fixed-phase and free-phase fidelity for multi-subsystem gates. Free-phase is the primary metric. Fixed-phase routinely underreports by 6–80 pp for entangling gates. Ref: [[insight-20260412-054400-synthesis-free-phase-gap-scales-with-gate-type]].

```julia
qcp = SplinePulseProblem(qtraj;
    integrator = integrator,
    Q = 100_000.0, R = 1e-4,
    du_bound = 5.0,
    Δt_bounds = (190.0, 1905.0),  # ns — (0.3, 3.0) × T/(N-1) at N=25; nominal 635
    free_phase = true,
    initial_phases = [-phi_q, -phi_c],
)
```

## Gate Targets

| Gate | Definition | Formulation |
|------|-----------|-------------|
| CPHASE($\pi$) | $|e,n\rangle \to e^{i\pi n}|e,n\rangle$ | `MultiKetTrajectory`, drift warm start at $T = \pi/\chi$ |
| CPHASE($\pi/2$) | $|e,n\rangle \to e^{i\pi n/2}|e,n\rangle$ | `MultiKetTrajectory`, drift $T = \pi/(2\chi)$ |
| GKP state prep | Encoded logical qubit in Fock space | `MultiKetTrajectory`, $N_{\text{Fock}} \sim 15$–$25$ |
