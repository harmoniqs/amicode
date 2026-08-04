---
name: warm-start
description: Decide whether and how to warm-start a Piccolo optimization — seed sources, the exact loading idioms, and the transfer risks. Use before any solve that is not a deliberate cold-start study.
agents: [researcher, experimenter]
surface: public
scenarios: [cz-gate-reuse-warm-start, cz-gate-wrong-family-warm-start, warm-start-in-catalog-not-surfaced, recommend-from-ledger-warm, calibration-drift-reoptimize, kernel-reuse]
---

Warm-starting is the default posture: a related solved pulse almost always beats a
cold start in iterations and final fidelity. This card covers the *decision* (start
from what?) and the *mechanics* (the exact idioms — these are the ones that
`MethodError` when guessed).

## Usage

`/warm-start` — decide on and construct a warm start for the current problem.

The argument is: $ARGUMENTS

## The decision — seed sources, in preference order

1. **Your own prior solve** of the same/nearby problem — `load_pulse("….jld2")`.
2. **The pulse catalog** — `amico catalog query --platform <p> --kind <k>` returns
   banked, verified pulses with provenance. Same platform + same target + system
   parameters within ~5% ⇒ adopt it.
3. **An analytic seed** for the platform: DRAG for transmon ($\varepsilon_Q = -\dot\Omega/\alpha$),
   the constant-$|\Omega|$ Jandura–Pupillo profile for Rydberg CZ ($T\cdot\Omega_{\max} = 7.6114828$),
   the drift pulse for dispersive bosonic gates ($T = \pi/\chi$, drives ≈ 0 is the *exception*
   to the never-zero rule below — the drift itself does the work). See the platform skill.
4. **Random within bounds** (a true cold start): `UnitaryTrajectory(sys, U_goal, T)` samples
   each drive uniformly within `drive_bounds`. For hard problems prefer a multistart
   campaign over a single cold seed.

Cold-start deliberately when: the problem is genuinely new (no matching structure), or
you are measuring baseline difficulty. Otherwise warm-start.

## Mechanics — the exact idioms

**From a saved pulse (the canonical path):**

```julia
pulse = load_pulse("data/X_fidelity.jld2")          # JLD2 file with key "pulse"
qtraj = UnitaryTrajectory(sys, pulse, U_goal)        # rolls the ODE at construction
qcp   = SplinePulseProblem(qtraj)                    # NO N argument ⇒ native knot times,
solve!(qcp; max_iter = 200)                          # warm start preserved EXACTLY
```

Passing `N` (or a `times` vector) to `SplinePulseProblem` **resamples the pulse onto a new
grid** — only do that intentionally (see grid transfer below). For `ZeroOrderPulse` seeds
use `SmoothPulseProblem(qtraj, N)`; for switching controls, `BangBangPulseProblem`.

**From an optimized problem still in memory:**

```julia
pulse = get_pulse(qcp.qtraj)          # after solve! (sync is automatic)
# or from a raw NamedTrajectory:
pulse = ZeroOrderPulse(traj)                          # drive_name = :u
pulse = CubicSplinePulse(traj)                        # needs :u AND :du components
```

**Across knot grids / parameterizations** (e.g. coarse → fine, spline → piecewise-constant):

```julia
u_new = sample(pulse, new_times)                      # (n_drives × N_new)
pulse_new = LinearSplinePulse(u_new, new_times)
```

## Rules

1. **Never seed with a zero-amplitude pulse** (outside the bosonic drift exception).
   Zero drives sit at a stationary point of the fidelity landscape; the optimizer stalls.
2. **Warm starts skip the L-BFGS phase** — go straight to the exact-Hessian solve. The
   L-BFGS phase exists to escape the cold-start plateau you no longer have.
3. **Grid mismatch is the top transfer risk**: a pulse resampled onto a mismatched knot
   count/type silently degrades. Prefer the no-`N` construction; resample explicitly when
   you must, then **verify the seed before solving** (`fidelity(qtraj)` — it should be
   near the donor's verified value).
4. **Pin non-phase globals during the initial pulse solve** — pass `global_names = Symbol[]`
   so system parameters (χ, couplings) are not silently co-optimized with the pulse.
5. **Free-phase chains hit the ±2π wall**: after 2–3 warm-started rounds the φ globals pin
   at the default bounds. Unwrap phases on load and widen `global_bounds` (e.g. ±10π)
   for min-time chains.
6. **Transfer beats scratch even across durations**: to solve at $T' \ne T$, time-rescale
   the seed (`sample` onto `range(0, T′, length=N)`), then re-optimize.

## Verify the seed, then verify the result

A warm start is a claim like any other: check `fidelity(qtraj)` right after construction
(is the seed as good as advertised on *your* system?), and after solving run the full
re-rollout verification from the `simulate` skill.

## Bookkeeping

Query before solving: `amico catalog query` (warm-start seed) and `amico vault query`
(prior insights on this problem family). After a verified solve: `amico note write --from-run`,
then `amico catalog ingest --from-run` so the next problem warm-starts from yours.
