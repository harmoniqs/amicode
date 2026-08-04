# Setup — Script review checklist

When `/setup review` is invoked, read the script the user is working on and audit it against
each item below, reporting violations. Each item maps to a rule in [rules.md](rules.md).
Loaded on demand from [`../SKILL.md`](../SKILL.md).

- [ ] Initial T sits near the physical optimum, not arbitrarily generous — cold start only
- [ ] `Δt_bounds` is set in SplinePulseProblem, and brackets the nominal step
      `Δt_nom = T/(N-1)` (roughly `(0.3, 3.0) .* Δt_nom`). **Flag** an upper bound exceeding `T`,
      or a lower bound above `Δt_nom` — both are mis-specified, not merely permissive
- [ ] Time is left **free** and timesteps **unequal** — Piccolo's defaults. **Flag** a pinned
      grid (`Δt_bounds = (x, x)`) or `PiccoloOptions(timesteps_all_equal = true)` anywhere except
      a device-clock emission (`pasqal`); it removes a real degree of freedom
- [ ] **Flag** a pinned grid on any problem later chained into `MinimumTimeProblem` — fixed Δt
      means fixed duration, so min-time becomes a no-op
- [ ] Cold start: L-BFGS fidelity phase before exact Hessian fidelity phase
- [ ] Warm start: skips L-BFGS fidelity, goes straight to exact Hessian
- [ ] MinimumTimeProblem is used after fidelity convergence
- [ ] Min-time uses L-BFGS→Hessian pattern (both cold and warm starts)
- [ ] L-BFGS phases use `eval_hessian=false`
- [ ] Drive selection is justified by matrix element magnitudes
- [ ] SplineIntegrator uses QuantumSystem with explicit H_drives (not function-based G)
- [ ] The solved PULSE is saved (`jldsave(f; pulse = get_pulse(qcp.qtraj))`) after every stage, so it can warm-start
- [ ] Energy shift is enabled (default — check it's not disabled)
- [ ] Pulse type matches what the hardware executes — `LinearSplinePulse` where a slew rate is
      hard-capped (atoms, ion AOM), `CubicSplinePulse` where the AWG interpolates smoothly
- [ ] `du_bound` traces to a published slew spec, not a round number. **Flag** a scalar
      `du_bound` where channels have different caps (atoms Ω vs Δ) — that wants `du_bounds`
- [ ] Knot count is within the three-way budget: shape floor (13–17 1Q, 17–25 2Q, 25–33 3Q),
      slew ceiling `N ≤ T·(slew_max/u_max)+1`, memory ceiling `N × state_dim`
- [ ] `N-1` is divisible by `Threads.nthreads()` (interval loops are the threaded unit).
      **Flag** an `N-1` that is prime or awkward, e.g. `N=48` → 47 intervals
- [ ] Free-phase used for entangling gates with EmbeddedOperator targets
- [ ] Magnus integrator used for stiff systems (3-level Rydberg, fluxonium)
- [ ] Free-phase fidelity reported separately from fixed-phase fidelity
- [ ] Pre-solve diagnostics: problem display, initial fidelity, pulse summary (for warm starts)
- [ ] Between-phase diagnostics: fidelity + pulse summary printed between solver phases
- [ ] CubicSplinePulse accessed via `get_knot_values`/`get_knot_derivatives` (not `pulse.u`)
