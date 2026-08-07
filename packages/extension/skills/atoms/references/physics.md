# Atoms — Physics reference

Deep physics for neutral-atom Rydberg qubits: the Hamiltonian, the 3-level dark-state
model, the error-mitigation ladder, free-phase optimization, the Jandura–Pupillo warm
start, and the multi-stage optimization strategy. Loaded on demand from
[`../SKILL.md`](../SKILL.md).

Everything here is **pure public Piccolo**. Where a system has no shipped template, the
explicit construction is given — that is the physics, and it is short.

## Hamiltonian

$$H(t) = \sum_i \left[\tfrac{\Omega_x(t)}{2}\sigma^x_i + \tfrac{\Omega_y(t)}{2}\sigma^y_i
        - \Delta_i(t)\, n_i\right] + \sum_{i<j} \frac{C_6}{r_{ij}^6}\, n_i n_j$$

- $\Omega_x, \Omega_y$: global Rabi drives (rotate every atom together). On hardware these
  are one amplitude $\Omega$ and one phase $\phi$; `ignore_Y_drive = true` models that
  directly, giving drives $[\Omega, \Delta]$.
- $\Delta_i$: detuning — global on most devices, per-atom where local addressing exists.
- $n_i = |r\rangle\langle r|_i$: Rydberg population operator.
- $C_6/r^6$: van der Waals interaction. All-to-all in principle; the $1/r^6$ falloff means
  nearest neighbours dominate overwhelmingly.

**Units.** µs and rad/µs (angular frequency) throughout. Gate times land in ~0.26–5 µs.
Published tables quote MHz — multiply by $2\pi$.

## 2-level: the shipped template

```julia
using Piccolo
sys = RydbergChainSystem(N = 3, C = 862_690 * 2π, distance = 8.7,
                         cutoff_order = 1,        # nearest-neighbour only
                         all2all = false,         # or true for the full 1/r^6 sum
                         ignore_Y_drive = true,
                         drive_bounds = [15.8 * 2π, 124.0 * 2π])
```

Drives are ordered `[Ωx, (Ωy,) Δ]`. `sys.n_drives` is 2 with `ignore_Y_drive = true`, 3
without. The template puts atoms on a **line** at uniform `distance`; for a 2-D register or
non-uniform spacing, build explicitly (below).

## 2-level: explicit construction (any geometry)

```julia
using Piccolo, LinearAlgebra
const ⊗ = kron

σx = ComplexF64[0 1; 1 0]; σy = ComplexF64[0 -im; im 0]
n_r = ComplexF64[0 0; 0 1]; I2 = Matrix{ComplexF64}(I, 2, 2)

"Lift a single-atom operator to site i of N."
lift(op, i, N) = reduce(⊗, [k == i ? op : I2 for k in 1:N])

positions = [(0.0, 0.0), (8.7, 0.0), (4.35, 7.53)]   # µm — a triangle
N  = length(positions)
C6 = 862_690 * 2π

H_drift = zeros(ComplexF64, 2^N, 2^N)
for i in 1:N, j in (i + 1):N
    r = hypot(positions[i][1] - positions[j][1], positions[i][2] - positions[j][2])
    H_drift += (C6 / r^6) * lift(n_r, i, N) * lift(n_r, j, N)
end

H_Ω = sum(lift(σx, i, N) for i in 1:N) / 2      # global amplitude
H_Δ = -sum(lift(n_r, i, N) for i in 1:N)        # global detuning, Pulser sign
sys = QuantumSystem(H_drift, [H_Ω, H_Δ], [(0.0, 15.8 * 2π), (-124.0 * 2π, 124.0 * 2π)])
```

**Per-atom detuning** (local addressing): push one `-lift(n_r, i, N)` per atom instead of
the summed `H_Δ`, and give each its own bound. **Zoned** detuning: sum over the sublattice.
Amplitude is nonnegative on real hardware — bound $\Omega$ as `(0.0, Ω_max)`, not symmetric.

## 3-level dark-state model

For physics-accurate modelling of the qubit → Rydberg pathway, each atom carries
$\{|0\rangle, |1\rangle, |r\rangle\}$. The essential asymmetry: **$|0\rangle$ is dark** —
the laser couples $|1\rangle \leftrightarrow |r\rangle$ only. There are therefore no
single-qubit gates in this model; it exists to get entangling gates and their leakage right.

```julia
# Single-atom operators in the 3-level basis {|0⟩, |1⟩, |r⟩}
σx_1r = ComplexF64[0 0 0; 0 0 1; 0 1 0]      # |1⟩⟨r| + |r⟩⟨1|
σy_1r = ComplexF64[0 0 0; 0 0 -im; 0 im 0]
n_r3  = ComplexF64[0 0 0; 0 0 0; 0 0 1]
I3    = Matrix{ComplexF64}(I, 3, 3)
lift3(op, i, N) = reduce(kron, [k == i ? op : I3 for k in 1:N])
```

Build `H_drift` from `lift3(n_r3, …)` pairs exactly as above, drives from `σx_1r`/`σy_1r`
and `-n_r3`. The target lives on the computational subspace:

```julia
levels   = fill(3, N)                                  # 3 levels per atom
subspace = get_subspace_indices([1:2 for _ in 1:N], levels)   # {|0⟩,|1⟩}^N inside 3^N
U_goal   = EmbeddedOperator(GATES[:CZ], subspace, levels)
```

`EmbeddedOperator` makes `fidelity` report the subspace (Pedersen) average-gate fidelity
automatically, and `get_leakage_indices(U_goal)` hands you the leakage levels for a
`LeakageConstraint` or `LeakageObjective` (see the `constraints` skill).

**Integrator.** Deep blockade means a large eigenvalue spread ($V_{nn} \sim 2800$ rad/µs vs
$\Omega \sim 29$ rad/µs), i.e. stiff dynamics. The public default (`BilinearIntegrator` for
spline problems) is fine for 2-level; for stiff 3-level work a unitarity-preserving
Magnus-class integrator is the right tool — available with the entitled solver stack
(entitlement `issimo`), which supplies `SplineIntegrator(qtraj, N; alg = …)`. Without it,
tighten tolerances and shorten timesteps, and *check the re-rollout*: a stiff system
integrated loosely is the classic source of an optimizer/rollout disagreement.

## Error-mitigation ladder (4- and 5-level)

To model specific error channels in the two-photon excitation $|1\rangle \to |i\rangle \to
|r\rangle$:

| Levels/atom | Basis | Error channel modelled | Drives |
|---|---|---|---|
| 4 | $\|0\rangle,\|1\rangle,\|i\rangle,\|r\rangle$ | intermediate-state scattering | $\Omega_x, \Omega_y$ (upper-leg laser) |
| 5 | $\|0\rangle,\|1\rangle,\|i\rangle,\|r_1\rangle,\|r_2\rangle$ | off-resonant Rydberg level | $\Omega_x, \Omega_y$ |

What changes versus 3-level:

- **Non-Hermitian drift.** Decay enters as $-i\gamma/2$ terms in `H_drift`; construct with
  `QuantumSystem(H_drift, H_drives, bounds; hermitian = false)`.
- **`MultiKetTrajectory`, not `UnitaryTrajectory`** — propagate the computational basis kets
  in the full space rather than the whole propagator (cheaper, and the only sane choice once
  the dimension is $4^N$/$5^N$). Use `coherent = true` for gate targets.
- **Non-unitary dynamics rules Magnus out** — a Magnus integrator assumes unitarity. Use the
  default non-stiff path.
- **Two control channels only** ($\Omega_x, \Omega_y$); the lower-leg coupling is a constant
  in the drift, not a control.
- **Free-phase** needs `subsystem_levels = [4, 4]` (or `[5, 5]`).

Stage them: solve the 4-level problem, then warm-start the 5-level problem from its pulse
(see the `compose` skill, P4).

## Free-phase optimization

For entangling gates, single-qubit $Z$ frames are free in hardware — absorb them into the
objective rather than demanding the pulse produce them:

```julia
qcp = SplinePulseProblem(qtraj;
    Q = 100_000.0, R_u = 1e-4, R_du = 1e-5,
    du_bounds = [250.0 * 2π, 250.0 * 2π],    # [Ωx, Ωy] — both are Rabi channels, rad/µs²
    Δt_bounds = (0.0066, 0.066),             # (0.3, 3.0) × T/(N-1) for the 263 ns / 13-knot CZ
    free_phase = true)                        # adds φ₁, φ₂ … globals to the OBJECTIVE
```

`free_phase = true` requires an `EmbeddedOperator` goal (or `subsystem_levels` for ket
problems) and never touches the Hamiltonian. It is decisive: moderate-blockade CZ can read
33–88% fixed-phase while exceeding 99.9% free-phase.

> **Fidelity convention.** Always report both numbers for a multi-subsystem gate. Free-phase
> is the primary metric; fixed-phase routinely underreports by 6–80 pp for entangling gates.
> Read the phases back from the trajectory globals (`φ_1, φ_2, …`) and pass them to
> `fidelity(qtraj; phases = φ)` — the `simulate` skill has the exact idiom. Omitting them
> silently undershoots the objective you actually solved.

## Jandura–Pupillo warm start (deep-blockade CZ)

The time-optimal CZ pulse of Jandura & Pupillo (arXiv:2202.00903) is the best analytic seed
for deep blockade: constant $|\Omega| = \Omega_{\max}$ with a varying phase $\phi(t)$
reconstructed from the PMP costates, at the speed limit

$$T \cdot \Omega_{\max} = 7.6114828 .$$

At $\Omega/2\pi = 4.6$ MHz that is $T \approx 263$ ns. Seed $\Omega$ flat at $\Omega_{\max}$
and put the structure in the phase (or in $\Delta$, if you are modelling amplitude+detuning),
then optimize. Treat the published constant as the *speed limit to beat or match* — a solve
that claims faster at equal fidelity is a result worth double-checking, not celebrating.

## Multi-stage optimization strategy

1. **Quasi-Newton with `free_phase`** (~300 iters) — fast basin-finding from the warm start.
2. **Exact-Hessian polish** (~500 iters) — recover the last digits of fidelity.
3. **Min-time, quasi-Newton** (~1000 iters) — compress duration aggressively
   (`MinimumTimeProblem(qcp; final_fidelity = <verified F> − margin)`).
4. **Min-time, exact Hessian** (~1000 iters) — recover fidelity in the short-duration basin.

This routinely yields 5–10× duration compression at 99.999%+ for 2-level gates, and
near-speed-limit CZ for 3-level. Verify after **every** stage — a chain amplifies an
unverified stage-1 claim (see the `compose` and `simulate` skills). Repeated min-time rounds
with `free_phase` walk the phase globals into the ±2π bound; unwrap and widen
`global_bounds` between rounds.
