# Atoms — Gotchas & key files

Edge cases to watch for, and where the atoms code lives. Loaded on demand from
[`../SKILL.md`](../SKILL.md).

## Gotchas

1. **Global drives limit individual control.** A global-drive register cannot independently
   rotate individual atoms. If the task needs qubit selectivity, add per-atom (or per-sublattice)
   detuning drives — see [systems-and-gates.md](systems-and-gates.md).
2. **C₆ scaling is steep.** 1/r⁶ means nearest-neighbor interaction dominates heavily.
   Atoms beyond ~2 lattice spacings contribute negligibly.
3. **Detuning slew rate is 8x faster than Rabi** (2000 vs 250 MHz/μs). Detuning channels
   can track faster dynamics.
4. **Units are μs and rad/μs** (angular frequency). Gate times are ~0.26-5 μs. QuEra and
   Infleqtion constants use explicit `× 2π`; Aquila lattice constants are in the same
   angular frequency units but written as bare numbers.
5. **Match the parameterization to the consumer — `LinearSplinePulse` for atoms.** This hardware
   consumes piecewise-linear time series and publishes hard slew caps, and a linear spline's
   `du` *is* the constrained inter-knot slope, so `du_bounds` bounds the realized slew rate
   everywhere. `CubicSplinePulse` buys $C^1$ smoothness with fewer knots but bounds slope only
   *at* knots — the interpolant can overshoot in between, so it cannot certify the cap. Reserve
   `ZeroOrderPulse` for a channel that genuinely holds samples instead of ramping between them.
   Resampling between bases costs fidelity — verify the seed after any transfer (`compose` P3).
6. **3-level |0⟩ is dark.** Laser only couples |1⟩ ↔ |r⟩. Cannot do single-qubit gates on
   {|0⟩, |1⟩} in the 3-level model — only entangling gates via Rydberg blockade.
7. **Free-phase fidelity vs fixed-phase.** For `free_phase=true` optimizations, the raw
   `fidelity(qtraj)` reports fixed-phase fidelity which can be misleadingly low. Always
   extract and apply the optimized φ values.
8. **Magnus integrators for 3-level.** Default Tsit5 works for 2-level but 3-level
   deep-blockade systems (V_nn/Ω >> 1) need `MagnusGL4Alg` or `MagnusAdapt4Alg` for
   stability and unitarity.
9. **Gate-zone architectures are global-drive.** Shuttling atoms into a gate zone gives you
   close spacing and deep blockade, not local addressability — model the drive as global and
   put the selectivity in the geometry.
10. **Amplitude is nonnegative.** Bound $\Omega$ as `(0.0, Ω_max)`. A solve that wants negative
   amplitude is asking for a phase flip; give it the phase (or the $\Omega_y$ drive) instead.
11. **The blockade radius is a precondition, not a diagnostic.** Compute
   $R_b = (C_6/\Omega)^{1/6}$ and compare it against every pair spacing *before* solving. A
   two-qubit gate attempted at $r \gg R_b$ cannot exist, and the optimizer will spend its whole
   budget discovering that.

## Where the code comes from

There is no atoms library to import: every system in this skill is built from `Piccolo`
primitives in a handful of lines, and that is deliberate — an authored script must be
self-contained and runnable by someone with only the public package.

| You need | Go to |
|---|---|
| a global-drive line register | `RydbergChainSystem` ([systems-and-gates.md](systems-and-gates.md)) |
| any other geometry, local detuning, 3+ levels | the explicit lift-and-sum build ([physics.md](physics.md)) |
| published device numbers | [parameters.md](parameters.md) |
| the analog / MIS workflow | [analog.md](analog.md) |
| running it on real hardware | the `pasqal` skill |
