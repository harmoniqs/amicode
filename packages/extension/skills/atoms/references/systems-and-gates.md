# Atoms — Register geometries, system construction & gate targets

Register architectures, how to build each in public Piccolo, gate targets, and trajectory
types. Loaded on demand from [`../SKILL.md`](../SKILL.md).

## The three levels of addressability

Neutral-atom hardware differs mainly in *what you can address individually*. That choice is
made in the drive list, not in a special constructor.

| Architecture | Drive list | Individual control | Build it with |
|---|---|---|---|
| **Global** | $[\Omega_x, (\Omega_y,) \Delta]$ | none — one knob for the register | `RydbergChainSystem(...)`, or explicit with summed drives |
| **Local detuning** | $[\Omega_x, (\Omega_y,) \Delta_1 \ldots \Delta_N]$ | per-atom detuning ⇒ full selectivity | explicit: one `-lift(n_r, i, N)` drive per atom |
| **Zoned detuning** | $[\Omega_x, (\Omega_y,) \Delta_\text{odd}, \Delta_\text{even}]$ | sublattice selectivity | explicit: sum `n_r` over each sublattice |

`RydbergChainSystem` also takes `local_detune = true`, which appends **one** local-detuning
pattern — useful, but if you need $N$ independent detunings, build explicitly.

Amplitude is nonnegative in hardware ($\Omega \geq 0$; the sign lives in the phase). Bound it
`(0.0, Ω_max)`, never symmetric. `ignore_Y_drive = true` drops $\Omega_y$ and matches the
amplitude+phase parameterization real devices expose.

## System construction

```julia
using Piccolo

# 1. Global, uniform line — the template
sys = RydbergChainSystem(N = 3, C = 862_690 * 2π, distance = 8.7,
                         ignore_Y_drive = true,
                         drive_bounds = [15.8 * 2π, 124.0 * 2π])

# 2. Deep-blockade pair at close spacing (gate-zone style: atoms shuttled to ~2 µm)
sys = RydbergChainSystem(N = 2, C = 28_800 * 2π, distance = 2.0,
                         ignore_Y_drive = true,
                         drive_bounds = [4.6 * 2π, 20.0 * 2π])

# 3. Arbitrary geometry / local detuning / 3-level — explicit build.
#    See references/physics.md for the full lift-and-sum idiom.
```

`drive_bounds` entries may be a scalar `b` (⇒ `(-b, b)`) or an explicit `(lo, hi)` tuple.
Order must match the `H_drives` order.

## Choosing the number of levels

| Model | Levels/atom | Use when |
|---|---|---|
| 2-level $\{\|g\rangle, \|r\rangle\}$ | 2 | analog work, register dynamics, MIS, fast design iteration |
| 2-level $\{\|0\rangle, \|1\rangle\}$ effective | 2 | gate design where Rydberg population is adiabatically eliminated |
| 3-level $\{\|0\rangle, \|1\rangle, \|r\rangle\}$ | 3 | entangling gates with honest leakage; comparison to analytic optima |
| 4/5-level | 4–5 | modelling specific decay/off-resonance channels (physics.md) |

Design in the cheap model, **verify in the fuller one**: solve 2-level, re-roll the pulse
through the 3-level system, and report the 3-level number. A fidelity that survives the
level upgrade is a result; one that doesn't was a modelling artifact.

## Gate targets

```julia
GATES[:X]; GATES[:Y]; GATES[:Z]; GATES[:H]; GATES[:CZ]; GATES[:CX]
```

| Gate | Qubits | Native on Rydberg? | Notes |
|---|---|---|---|
| X, H, √X | 1 | no | Rabi rotation; unavailable in the 3-level dark model |
| **CZ** | 2 | **yes** | the blockade gate — see below |
| CX / CNOT | 2 | no | CZ conjugated by single-qubit rotations, or shaped directly |
| √iSWAP | 2 | no | alternative entangler |
| CCZ / Toffoli | 3 | partly | blockade extends naturally to a shared Rydberg constraint |

**Why CZ is native.** When one atom is excited to $|r\rangle$, the $C_6$ interaction shifts
its neighbour off resonance, forbidding a second excitation. The forbidden path accrues a
conditional phase — that *is* a CZ, up to single-qubit $Z$ frames (hence `free_phase`).

For a model with leakage levels, wrap the target:

```julia
levels   = fill(3, N)
subspace = get_subspace_indices([1:2 for _ in 1:N], levels)
U_goal   = EmbeddedOperator(GATES[:CZ], subspace, levels)
leak     = get_leakage_indices(U_goal)      # feed a LeakageConstraint / LeakageObjective
```

## Trajectory types

| Trajectory | Use for |
|---|---|
| `UnitaryTrajectory(sys, pulse, U_goal)` | gates; goal is a matrix or `EmbeddedOperator` |
| `KetTrajectory(sys, pulse, ψ0, ψ_goal)` | state preparation — the analog/MIS case |
| `MultiKetTrajectory` | gates in a large space with few relevant kets (4/5-level); `coherent = true` |
| `DensityTrajectory` | open-system dynamics; cost $O(\dim^2)$ |

Construction **solves the ODE**, so `fidelity(qtraj)` right after building is a real number:
use it to check a warm-start seed before spending an optimization on it.

## Blockade radius — the geometry sanity check

$$R_b = \left(\frac{C_6}{\Omega}\right)^{1/6}$$

Atoms closer than $R_b$ are blockaded; further apart they are effectively independent. Before
trusting any register: compute $R_b$ at your $\Omega$ and compare against the spacings. A
"two-qubit gate" at $r \gg R_b$ is two one-qubit gates, and no amount of optimization fixes
it. The ratio $V_{nn}/\Omega$ is the useful dimensionless number — $\gtrsim 50$ is deep
blockade, $\sim 3$–5 is moderate (and moderate is where `free_phase` matters most).
