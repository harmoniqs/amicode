# Atoms — Hardware & optimization parameters

Published hardware parameter tables per platform, default optimization parameters, and
integrator selection. Loaded on demand from [`../SKILL.md`](../SKILL.md).

Every number here is a **published** device figure. Inline the ones you use directly into the
script — an authored script must run with nothing but `Piccolo`, so there is no constants
module to import. The `Constant` columns below are retained only as stable *names to use for
your own `const` bindings*, so scripts across a session stay mutually readable.

**Units are μs and rad/μs** (angular frequency). Gate times are ~0.26–5 μs. QuEra,
Infleqtion, and error-mitigation constants use explicit `× 2π`; Aquila-lattice constants
are in the same angular-frequency units but written as bare numbers.

## QuEra Gate Zone — ⁸⁷Rb, n=53, deep blockade

**Primary platform for demos.** QuEra shuttles atoms to a gate zone at d=2 μm.

| Parameter | Constant | Value | Units |
|-----------|----------|-------|-------|
| C₆ | `QUERA_RYDBERG_C6` | 28,800 × 2π | rad/μs·μm⁶ |
| Gate-zone spacing | `QUERA_RYDBERG_DISTANCE` | 2.0 | μm |
| V_nn/Ω | — | ~98 | (deep blockade) |
| Rabi max | `QUERA_RYDBERG_RABI_MAX` | 4.6 × 2π | rad/μs |
| Detuning max | `QUERA_RYDBERG_DELTA_MAX` | 20.0 × 2π | rad/μs |
| Rabi slew rate | `QUERA_RYDBERG_RABI_SLEW` | 250.0 × 2π | rad/μs² |
| Rydberg lifetime | `QUERA_RYDBERG_TAU_R` | 88 | μs |
| J&P CZ speed limit | — | T·Ω = 7.6114828 → ~263 ns | — |
| Experimental ref | — | ~260 ns, 99.5% (Evered et al. 2023) | — |

## ⁸⁷Rb / Aquila lattice

| Parameter | Constant | Value | Units |
|-----------|----------|-------|-------|
| C₆ | `RYDBERG_C6` | 862,690 × 2π | MHz·μm⁶ |
| Lattice spacing | `RYDBERG_DISTANCE` | 8.7 | μm |
| Rabi max | `RYDBERG_RABI_MAX` | 15.8 | MHz |
| Detuning max | `RYDBERG_DELTA_MAX` | ±124.0 | MHz |
| Rabi slew rate | `RYDBERG_RABI_SLEW` | 250 | MHz/μs |
| Detuning slew rate | `RYDBERG_DELTA_SLEW` | 2000 | MHz/μs |

## ¹³³Cs / Infleqtion — moderate blockade

| Parameter | Constant | Value | Units |
|-----------|----------|-------|-------|
| C₆ | `CS_RYDBERG_C6` | 480,557 × 2π | rad/μs·μm⁶ |
| Atom spacing | `CS_RYDBERG_DISTANCE` | 6.0 | μm |
| V_nn/Ω | — | ~3.4 | (moderate blockade) |
| Rabi max | `CS_RYDBERG_RABI_MAX` | 3.0 × 2π | rad/μs |
| Detuning max | `CS_RYDBERG_DELTA_MAX` | 20.0 × 2π | rad/μs |
| Rabi slew rate | `CS_RYDBERG_RABI_SLEW` | 100.0 × 2π | rad/μs² |

## J&P deep blockade — ⁸⁷Rb, d=4 μm

| Parameter | Constant | Value | Units |
|-----------|----------|-------|-------|
| Atom spacing | `JP_RYDBERG_DISTANCE` | 4.0 | μm |
| V_nn/Ω | — | ~84 | (deep blockade) |
| Rabi max | `JP_RYDBERG_RABI_MAX` | 15.8 | MHz |
| Rydberg lifetime | `JP_RYDBERG_TAU_R` | 130 | μs |
| J&P CZ benchmark | — | T·Ω_max = 7.6114828 | — |

## Default optimization parameters

Pulse is **`LinearSplinePulse`** and the template **`SplinePulseProblem`** on every row: this
hardware consumes piecewise-linear time series and hard-caps slew, so the constrained
inter-knot slope of a linear spline is what makes `du_bounds` a real guarantee rather than a
knot-point-only wish (see the `problem-types` Axis 2 table).

| Parameter | 1Q (Aquila) | 2Q (Aquila) | 3Q (Aquila) | QuEra CZ (gate zone) |
|-----------|-----|-----|-----|----------|
| T (initial) | 1.1 μs | 1.6 μs | 2.5 μs | ~263 ns (J&P) |
| N_knots | 17 | 25 | 33 | 13 |
| N−1 (threaded intervals) | 16 | 24 | 32 | 12 |
| Slew ceiling `T·(slew/u_max)+1` | 18.4 | 26.3 | 40.5 | 15.3 |
| max_iter | 100 | 300 | 500 | 300+500+2000 |
| Q | 100,000 | 100,000 | 100,000 | 100,000 |
| R_u | 1e-4 | 1e-4 | 1e-4 | 1e-4 |
| R_du | 1e-5 | 1e-5 | 1e-5 | 1e-5 |
| `du_bounds` = [Ω, Δ] | [250, 2000] MHz/μs | same | same | [250, 2000]×2π rad/μs² |
| Δt_bounds | (0.021, 0.21) μs | (0.02, 0.2) μs | (0.023, 0.23) μs | (0.0066, 0.066) μs |

**Use the vector `du_bounds`, never the scalar `du_bound`.** Ω and Δ slew caps differ by 8× on
this hardware (250 vs 2000 MHz/µs); a scalar imposes the tighter one on the detuning channel
and quietly throws away most of its agility.

Every `Δt_bounds` above is `(0.3, 3.0) × T/(N-1)` — a bracket around the nominal step, not a
free-for-all. The former blanket `(0.01, 2.0) μs` allowed a *single* timestep twice as long as
the entire 1Q gate.

**How the knot counts were derived.** Each is the smallest of: shape floor (17–25 for 2Q,
25–33 for 3Q), the slew ceiling in the row above, and the memory ceiling. Then rounded to make
`N-1` divide by `Threads.nthreads()` — the solver threads over knot *intervals*,
`Threads.@threads for k = 1:(N-1)`, so `N ∈ {17, 25, 33}` balances on both 4 and 8 threads.

Two consequences worth internalizing:

- **The QuEra 263 ns CZ is slew-starved.** Its 2Q shape floor (17–25) collides with a slew
  ceiling of 15. That is the "floor exceeds ceiling" case: the gate sits *at* the hardware's
  expressivity limit, so expect the slew bound to be active at the solution. The old default of
  51 knots was 3.4× above that ceiling — those knots described waveform detail the hardware
  cannot produce, and cost memory to carry.
- **Knot count does not grow with register size.** It grows with duration and bandwidth. More
  atoms raises `dim`, which *tightens* the memory ceiling ($N \times 2\,\text{dim}^2$ for
  `UnitaryTrajectory`) while leaving the shape floor untouched. If a 3Q solve will not fit,
  switch to `MultiKetTrajectory` — per-knot cost drops from $\text{dim}^2$ to $k\,\text{dim}$ —
  before cutting `N` below its floor.

## Integrator selection

| System | Path | Rationale |
|--------|------|-----------|
| 2-level | public default (`BilinearIntegrator` for spline problems) | non-stiff dynamics; nothing else needed |
| 3-level, deep blockade (V_nn/Ω ≳ 50) | a unitarity-preserving Magnus-class integrator — entitled solver stack (`issimo`) | large eigenvalue spread ⇒ stiff; unitarity must be preserved by construction |
| 3-level, moderate blockade (V_nn/Ω ~ 3–5) | adaptive Magnus — entitled stack | moderate stiffness, variable scale |
| 4/5-level, non-Hermitian | public default | Magnus assumes unitarity, which decay breaks |

**On the public path only.** Stiff 3-level work without the entitled integrators is still
tractable: shorten timesteps, tighten tolerances, and treat the re-rollout check as
load-bearing rather than a formality — a stiff system integrated loosely is the classic
source of an optimizer-vs-rollout disagreement (see the `simulate` skill). Deep blockade with
V_nn ~ 2800 rad/µs against Ω ~ 29 rad/µs is exactly that regime.
