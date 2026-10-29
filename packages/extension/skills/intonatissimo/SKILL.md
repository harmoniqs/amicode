---
name: intonatissimo
description: Intonatissimo.jl usage — the entitled calibration tier. Measurement-matching objectives, NLP subproblem construction/updates, and the public-API ILC loop over Intonato's PulseTuningProblem chassis. Use when authoring a closed-loop pulse-tuning solve.jl in an Intonatissimo-enabled environment.
surface: entitled
entitlement: issimo
revision: 1
---

# Intonatissimo — usage guide

Intonatissimo is the entitled calibration tier: the measurement-matching
objective family, the control/calibration subproblem constructors, and the ILC
tuning strategy, all riding Intonato's public `PulseTuningProblem` loop. One
import reaches everything — `using Intonatissimo` re-exports the Intonato
chassis (which re-exports Piccolo), so `PulseTuningProblem`, `solve!`,
`Measurement`, `Learn` and friends are all in scope.

> **Delivery mode (read first).** Intonatissimo requires the **issimo
> entitlement**. It is delivered either as the **HP-mode prebuilt sysimage** or
> via a **private-registry sandbox environment** — it is **NOT in the default
> provisioned solve env**. Recipes in this skill run only in those environments;
> smoke-test signatures in the actual environment before launching.

## Measurement-matching objective

`MeasurementMatchingObjective(model, y_target, traj; Q = 1.0, weights = nothing)`
builds a `KnotPointObjective` whose loss at each measurement knot is
$\sum_i \big(w_i (g_i(x) - y_i)\big)^2$ — the objective that matches simulated
measurements to a target vector inside an NLP.

```julia
model = MeasurementModel(state_name(qtraj), [pop(), pop(), pop()], [1, 25, 50])
kpo, params = MeasurementMatchingObjective(model, y_target, traj; weights = w_vec)
```

- Returns **two** values: the objective (compose it like any other
  `AbstractObjective`) and a `Vector{MeasurementParam}` — **keep the params**.
- `MeasurementParam` is a mutable shared-reference container for one measurement
  point's target and weights. Mutate through the references between outer
  iterations; rebuilding the objective allocates and loses warm-start structure.
- `update_targets!(params, y_target)` — retarget in place. `y_target` is a
  `Vector{Measurement}` (a `Measurement` wraps one measurement vector plus an
  integer `index`). Here, as in `MeasurementModel` and `SimulatedExperiment`, the
  index is a **knot index** π_j ∈ 1:N of the pulse — the state is read at
  `get_knot_times(pulse)[index]`. See the hardware-path caveat below before
  mixing these with measurements from a soc.
- `update_weights!(params, w_flat)` — write the flattened per-element effective
  weights in model element order (measurement-major), in place.
- `weights` are per-measurement task-importance vectors. The legacy `Q` /
  `Q_meas` kwargs are deprecated aliases that fold into task weights — pass
  `weights`.

## Subproblem family

The subproblem constructors build the per-iteration control (and calibration)
NLPs that reuse the original problem's dynamics and constraints:

| Call | Role |
|---|---|
| `build_subproblem(qcp, model, y_target; R_tr, R_θ, Q_meas)` | Control NLP: measurement matching + per-component trust-region weights (`R_tr`, e.g. `(u = 1e-2, du = 1e-1)`) + global-variable regularizers (`R_θ`, e.g. `(ω = 1.0,)`) → `SubproblemHandle` |
| `build_subproblem(qcp, model, y_target; include_original_objective = true)` | Same, with the QCP's original objective (including infidelity) composed in — use when measurement-matching alone doesn't drive fidelity |
| `build_calibration_subproblem(qcp, model, y_exp; R_θ, Q_cal)` | Calibration NLP: matches **raw** experiment data `y_exp` (not ILC-shifted targets), states free, everything else pinned |
| `update_subproblem!(handle, y_target, z_ref[, model])` | In-place iteration step: retarget, recenter trust-region baselines on `z_ref`, warm-start the trajectory; the 4-arg form also refreshes precision weights at the current prediction |
| `update_pinned_values!(handle, z_ref)` | Refresh a calibration subproblem's pin values to the new reference trajectory |
| `make_global_regularizer(name, traj, R)` | Quadratic penalty $(R/2)\|\theta - \text{baseline}\|^2$ on one global variable — compose your own `R_θ` set if the constructors' NamedTuple form doesn't express it |

The discipline that makes this fast: **build once, update in place**. The
`SubproblemHandle` holds shared references to the objective's mutable parameters, so
`update_subproblem!` touches only targets, baselines, and the warm start —
no reconstruction between outer iterations.

```julia
handle = build_subproblem(qcp, model, y_target; R_tr = (u = 1e-2, du = 1e-1))
solve!(handle.prob; max_iter = 200)
update_subproblem!(handle, y_target_next, z_ref)   # next outer iteration, same problem
```

## Driving the public ILC loop

The loop chassis is Intonato's `PulseTuningProblem`: it wraps a solved
`QuantumControlProblem`, an experiment, and a measurement model, and runs the
outer propose → run experiment → retarget loop. The strategy kwarg selects the
inner step — pass an `ILCStrategy` to get Intonatissimo's ILC.

```julia
using Intonatissimo

mm    = MeasurementModel(state_name(qtraj), [pop(), pop(), pop()], [1, 25, 50])
expmt = SimulatedExperiment(qtraj_true, mm; rng = MersenneTwister(0))  # or a HardwareExperiment

ptp = PulseTuningProblem(qcp, expmt, mm; strategy = ILCStrategy())
solve!(ptp; max_iter = 5, tol = 1e-3, γ = 0.8, min_nominal_fidelity = 0.8)
# ptp.qcp is updated in place with the tuned result
```

- **Hardware-path index caveat (Intonato's QICK seam).** Through
  `StrumentoExperiment` → `StrumentoBackend` → a soc (`MockSoc`, `TwinSoc`,
  `StrumentoSoc`), the backend's `indices` are documented as knot indices, but
  every soc resamples the pulse onto its DAC grid
  (`floor(Int, T*dac_rate) + 1` points) and uses the integers as **DAC-sample**
  indices of that grid — while the returned `Measurement`s still carry the knot
  label. With N = 11, T = 5, `dac_rate = 20`, "index 11" is measured at t = 0.5,
  not t = 5, so `y_exp` and the model targets disagree for a reason that is not
  model error and ILC will "correct" it. Until Intonato measures at
  `t = knot_times[k]` on the soc path: pass each knot's sample index
  (`round(Int, t_k * dac_rate) + 1`) to the backend, or put the pulse's knots on
  the DAC grid, and check one evaluation against `SimulatedExperiment` before a
  loop. `SimulatedExperiment` itself is unaffected.
- **Plain ILC** is the bare `ILCStrategy()` — no parameter calibration.
- `solve!` kwargs: `max_iter` (outer iterations, default 5), `tol` (measurement
  error convergence, default 1e-3), `γ` (trust-region schedule factor, default
  0.8), `line_search` (Armijo backtracking, default `true`), `ipopt_options`
  (forwarded to the inner NLP solve), `max_rejections` (early stop after n
  consecutive line-search rejections), `min_nominal_fidelity` (refuses to run on a
  poorly-converged pulse; set 0 to skip). The old `polyak_avg` solve kwarg is
  **deprecated** — average the last n iterates before syncing by passing
  `selector = PolyakAverage(n)` to `PulseTuningProblem` instead.
- The goal measurements are resolved **once** at solve start and fixed for the
  whole solve — pass `y_goal = [...]` to `PulseTuningProblem` to supply them
  explicitly.
- The device model the loop plans against defaults to the nominal model of the
  QCP's system; pass `device_model = ...` to plan against something predictive
  (e.g. a parametric-Hamiltonian sysid model) instead.

### The QP-ILC step: which representation to use

`QPILCStrategy` (the QP inner step) is the production choice for correlator/population readouts. How to
shape its step was measured head-to-head in a research campaign (2026-10, transmon + Rydberg fixtures).
The production configuration (the relative-dose readout-null-space penalty, "FR_prod") and its measured
numbers live under **Production guidance** in the QP-ILC section below; the step-shaping lessons around it:

- **Don't shrink the box instead of penalizing the null space.** A smaller trust box removes visible and invisible motion in
  proportion. It helped at one fixture and did nothing at the other.
- **If you do project onto a basis** (`project_step` above, or your own), **clamp the projected step to
  the production box afterwards**. A raw projection discards the QP's pull back inside the drive bounds,
  so it produces out-of-bound pulses whenever the pulse sits at a bound (measured: on every accepted
  step).
- **Only correct drift that persists, and expect a modest gain.** If the drift is redrawn independently
  each round, no step representation beats leaving the pulse alone when the correction is scored on the
  next round. Under persistent drift a row-space-confined step helps on average, but recovers only part
  of the drift-induced infidelity, not most of it — see **Size expectations honestly** below for the
  measured, seed-dependent size. The gain is roughly a fixed fraction of the drift loss minus a per-step
  cost, so when the drift loss is small every representation did slightly worse than doing nothing.
- **Watch the in-loop refit.** A refit that re-centres its search on the previous estimate each round,
  with no prior pull, can random-walk away from the device. Measured: on 2 of 16 seeds the fitted Rabi
  scale drifted about 10% from truth while the true drift was about 1%, and fidelity fell round after
  round even though the accept gate kept accepting. Bound or anchor the learned parameters, and compare
  the refit's movement with the expected drift scale.
- **Check before trusting a full-QP run:** compare the step norm with the trust-box diagonal. A step at
  the diagonal is spending its norm in the null space.

### Calibration: learnable device parameters

`ILCStrategy(mode; kwargs...)` adds parameter calibration on top of plain ILC.
`mode` is `Alternating()` (a separate calibration NLP before each control NLP —
the robust default when controls outnumber measurements) or `Joint()`
(parameters and controls co-optimized in one NLP — use under strong measurement
coverage). Learnable parameters are declared once as `Learn` values keyed by
system-global name; each `Learn`'s `weight` becomes that parameter's
regularization strength, and the constructor validates the QCP against the
declarations before any device time is spent.

```julia
strat = ILCStrategy(Alternating();
    learn = (ω = Learn(ω_nom; bounds = (0.5ω_nom, 2.0ω_nom), weight = 5.0),),
    Q_cal = 1.0,                 # calibration-NLP measurement weight
    pin_Δt = true,               # pin per-knot Δt across outer iterations
    cal_eval_hessian = false,    # calibration NLP on Ipopt L-BFGS (the fast default)
)
ptp = PulseTuningProblem(qcp, expmt, mm; strategy = strat)
solve!(ptp; max_iter = 5)
```

- `Learn(init; bounds = (lo, hi), weight = 1.0)` — `bounds` is required (an
  unbounded learnable global is the failure mode this declaration exists to
  prevent); `Learn(; bounds = ...)` starts from the nominal value.
- A mode object with an empty `learn` set errors — bare `ILCStrategy()` is the
  plain-ILC form.
- `include_fidelity_in_u_nlp = true` also keeps the QCP's original objective in
  the control NLP, driving fidelity directly when measurement-matching has
  nontrivial kernel directions.
- The feedforward step itself is one call if you drive targets by hand:
  `y_target = compute_ilc_targets(y_goal, y_model, y_exp)` — element-wise
  $y_\text{goal} + y_\text{model} - y_\text{exp}$, pre-compensating the
  estimated model error $\hat\varepsilon = y_\text{exp} - y_\text{model}$.

## QP-ILC: `QPILCStrategy` (the one-shot hardware step)

`QPILCStrategy(; …)` is the second inner step for the same `PulseTuningProblem` chassis:
each outer iteration solves one box-constrained QP
$\min_\delta \tfrac12\delta^\top(G_w^\top G_w + \lambda I)\delta - r_w^\top G_w\delta$ on a
whitened measurement Jacobian $G_w$, inside per-channel trust boxes, and the chassis
accepts or reverts on the measured outcome. Typical pairing:
`acceptance = OneShotAcceptance(β = 0.25, ρ_rej = 2.0, k = 3.0)` plus an explicit
`y_goal`.

```julia
strat = QPILCStrategy(;
    jacobian    = AnalyticJacobian(),    # opt-in eigen/Daleckii–Krein G (10–100× faster)
    qp_backend  = :lowrank,              # opt-in identity-plus-low-rank box QP
    robust_mode = true,                  # null-space penalty λ‖P_null δ‖²
    robust_lambda_mode = :relative, robust_lambda = 1e2,   # the H25 production dose
)                                        # robust_rtol = nothing ⇒ 1e-8 under robust_mode
ptp = PulseTuningProblem(qcp, expmt, mm; strategy = strat,
    acceptance = OneShotAcceptance(β = 0.25, ρ_rej = 2.0, k = 3.0), y_goal = y_goal)
solve!(ptp; max_iter = 12)
strat.last_linearization   # (; Gw, rw, δ_lo, δ_hi) of the last successful step
```

The knobs merged since 2026-10-26 (Intonatissimo `main` @ `29a4c91`; docstring
`src/strategies/qp_ilc_strategy.jl:26-195`):

- **`jacobian`** — `ModelJacobian()` (default; per-interval AD on the nominal or
  recalibrated system), **`AnalyticJacobian()`** (#117, opt-in), `OpenSystemJacobian`
  (Lindblad FD), `InjectedJacobian` (empirical G). `AnalyticJacobian` differentiates the
  SAME discrete map as the AD source (midpoint substeps, the pulse's own interpolation)
  by exact eigen-exponentials and Daleckii–Krein divided differences — agrees with AD to
  its Taylor error (≲ 1e-12 relative on the campaign fixtures). It supports
  `ZeroOrderPulse` (one exact exponential per interval), `LinearSplinePulse` and
  `CubicSplinePulse` on **Hermitian, time-independent systems affine in the controls**
  (ket and stacked multi-ket); anything else falls back to the AD source with a one-time
  warning. It changes only G — the F-model diagnostic keeps the default Taylor rollout
  (`src/optimizers/analytic_jacobian.jl:33-77`).
- **`qp_backend`** — `:clarabel` (default), `:osqp`, or **`:lowrank`** (#115, opt-in): one
  thin SVD of $G_w$, the Hessian held exactly as $\alpha I + V D V^\top$ with the same
  robust-mode rank cut, pinned variables eliminated, bounds satisfied exactly, never an
  $n \times n$ matrix (≫ 50× faster than Clarabel on the 1206-DOF Rydberg shape —
  the Intonatissimo repo's 2026-10-27 low-rank QP benchmark note, #113). The #64 ensemble
  normal equations and the #66 `dt_dof` column are not identity-plus-low-rank and fall
  back to `:clarabel` with a one-time warning. Telemetry: `last_qp_backend`,
  `last_qp_iterations`, `last_qp_status`. Its solution tolerance is ~1e-8 — don't write
  equivalence clauses tighter than that (H27: a 1e-10 clause sat 3 decades below it).
- **`robust_mode`** (default `false`) — adds $\lambda\|P_\text{null}\delta\|^2$,
  $P_\text{null} = I - G_w^+ G_w$: penalizes J-invisible displacement (the E11 plateau fix).
  `robust_lambda` (default `1e-2`) is read per **`robust_lambda_mode`**: `:absolute`
  (default, prior numerics) or `:relative`, $\lambda_\text{eff} = $ `robust_lambda` ·
  $\sigma_\max(G_w)^2$ recomputed each step (telemetry `last_robust_lambda_eff`).
- **`robust_rtol`** (#110) — the singular-value cut of the projector. `nothing` (default)
  now means **`1e-8` under `robust_mode`** (`DEFAULT_ROBUST_RTOL`, `:23`); the old
  `pinv` cut (`eps·min(m, n)`) counted round-off modes as range and let the rank flip
  across iterations, so $I - G^+G$ stopped being a projector and the QP failed. Spell the
  old cut explicitly (`robust_rtol = eps(Float64) * min(size(Gw)...)`) only to reproduce
  pre-#110 runs. Telemetry `last_robust_rtol`. Also from #110: a pulse whose interior knot
  sits beyond the trust-box half-width outside its drive bound is clipped into bounds and
  re-linearized instead of asserting (`last_restored_to_bound`, `restored_to_bound_count`).
- **`last_linearization`** (#114, read-only) — after a successful step, that step's
  `(; Gw, rw, δ_lo, δ_hi)` (with the δT column under `dt_dof`), `==` a fresh
  linearization at the same inputs, so analysis code need not re-assemble G; `nothing`
  before the first step and after a failed QP. #114 also made the ZOH Jacobian hot paths
  fast and bit-identical (substep-exp hoist, F-model rollout reuse, threaded intervals).
- **Pulse bases** — the QP proposes in the pulse's native space: ZOH and linear knot
  values, cubic `[u; du]` (`du_frac` scales the tangent box); candidates are rebuilt in
  the same type (a ZOH stays a `ZeroOrderPulse`, `src/optimizers/qp_inner_solver.jl:814-830`).
  Design the pulse in its platform basis (PWL for AHS atoms, cubic elsewhere — ZOH is a
  playback property); the QP inherits it. #116 also replaced the fixed-order Taylor
  exponential with a norm-scaled one. Main's tests are re-paired to Piccolo #377's basis
  guards (#119) — on a Piccolo with #377, the nominal `qcp` must pass its pairing check.
- `ridge` is numerical damping, **not** a step-size control; the box radius
  (`tr_frac`, `tr_mode = :range | :gain`) is the knob.

**Production guidance (Rydberg persistent-drift fixture, H25 16 seeds / H27 32 seeds × 3
parameterizations; qpilc campaign ledger, personal vault):**

- For the full (unrestricted) QP use **`robust_mode = true`, `robust_lambda_mode =
  :relative`, `robust_lambda = 1e2`, `robust_rtol` default** ("FR_prod"). H25: 0 QP
  failures (the old pinv cut failed 17/192 rounds at the same λ — the rtol default, not
  the dose, removes them), non-inferior to the labelled restricted step, dose-insensitive
  over c ∈ {10, 100, 1000}. H27: FR_prod beat the unpenalized full QP at every
  parameterization (PWL13 25/32, PWL25 31/32, ZOH201 30/32 seeds).
- **Size expectations honestly:** the out-of-sample benefit vs doing nothing is small and
  seed-dependent (ZOH201 median 1.2e-4 at 32 seeds; H25's 6.08e-4 was an upper-tail draw).
  Read seed-paired contrasts, never absolute benefit at n ≈ 16.
- **The refit is the lever, not the step.** The per-seed losers are drift below the
  per-step cost and in-loop **refit runaways** (Spearman −0.63…−0.73 at ZOH), not step
  representation. rank($G_w$) = 5 at every parameterization tried (gate + 45-row readout
  physics), so a readout null space exists regardless of knot count; the next work is a
  prior-anchored / bounded refit (campaign R2 H26).
- At too few design columns the penalty costs **reach** (PWL13: ‖G_w δ‖ 0.50× the
  unpenalized step at 33 free columns) — check reach before adopting a coarse design.

## Error channels (call level)

For updates confined to a labelled set of dissipative error channels, the
public surface is four calls:

```julia
chans = [ErrorChannel(:T1_12, L_t1, 1e-3), ErrorChannel(:dephase, L_phi, 2e-4)]
sub   = error_channel_subspace(integrator, traj, chans)   # labelled gradient directions + orthonormal span
δx_p  = project_step(δx, sub)                             # project a proposed step onto the span
c     = capture(sub, direction)                           # fraction of the direction's energy the span explains
```

- `ErrorChannel(label::Symbol, L, γ)` — jump operator `L`, rate `γ > 0`, and a
  label (e.g. `:T1_12`, `:leakage_2`, `:dephase`) that rides through for
  attribution.
- `error_channel_subspace(integ, traj, channels; P_enc = nothing)` — one
  normalized gradient direction per channel plus the orthonormal span. The
  result carries an honest rank audit: structurally dependent channel sets
  (e.g. two diagonal channels differing by a multiple of identity) are dropped
  from the basis with a warning — read `size(sub.basis, 2)` for the working
  dimension, never assume your channel count.
- `capture` is the diagnostic for "are these K channels enough to explain this
  residual direction?" — a low value says the residual has components your
  channel set doesn't span.

> **Environment note (re-verified 2026-10-26).** The encoded-decay kernels this family consumes
> (`conjugation_frames` and companions, imported from Piccolissimo) are on **Piccolissimo main**
> since its PR #422 (merged 2026-09-05). The old `wip/414-conjugation-kernels` branch pairing is no
> longer needed. If `using Intonatissimo` fails with a missing-name error, your Piccolissimo
> predates that merge: update it. The calls above do not change.

## Display — the QILC problem in classic form

A QILC write-up (report finding, demo, paper section) states the problem
in classic optimization form, in the `formulation-display` house style,
before any results. Three equations, all from the constructors above:

**The measurement model.** Operators $\{M_j\}$ evaluated on the state at
measurement knots $t_k$:

$$y_k = \big(\langle\psi(t_k)| M_j |\psi(t_k)\rangle\big)_{j}, \qquad
y_{\text{model}} = h(z) \ \text{(NLP rollout)}, \qquad
y_{\text{exp}} = h_{\text{device}}(\text{pulse}) + \text{noise}$$

**The measurement-matching subproblem** (`build_subproblem`): control NLP
minimizing measurement error against shifted targets under a trust region:

$$\begin{split}
\underset{z}{\text{minimize}}\quad &
\lVert y(z) - y_{\text{target}} \rVert^2_{Q_{\text{meas}}}
+ R_{\text{tr}}\lVert u - u_{\text{ref}}\rVert^2
+ R_{\theta}\lVert\theta - \theta_{\text{ref}}\rVert^2 \\
\text{subject to}\quad & \text{trajectory dynamics (collocation)},\quad
\text{control + global bounds}
\end{split}$$

with the option to compose the original objective (infidelity) in when
measurement-matching alone does not drive fidelity.

**The ILC correction** (`compute_ilc_targets`): the model error estimate
$\hat\varepsilon = y_{\text{exp}} - y_{\text{model}}$ is pre-compensated
into the targets,
$y_{\text{target}} = y_{\text{goal}} + y_{\text{model}} - y_{\text{exp}}$,
and the loop iterates solve $\to$ apply $\to$ measure with Armijo
backtracking acceptance and the trust-region schedule $\gamma$; the
convergence criterion is measurement error $\le$ `tol`.

### The required display set (a QILC write-up always carries)

1. **The measurement model, drawn**: the operators, their knots, the goal
   targets $y_{\text{goal}}$ — a reader must see *what is being matched*
   before any correction makes sense.
2. **Pulse + correction plots, per iteration**: the applied pulse against
   the nominal, and the correction $\delta u$ per accepted iteration —
   the ILC's actual movement.
3. **Convergence**: measurement error and objective per outer iteration,
   accepted/rejected Armijo steps marked, trust-region radius against
   iteration.

A QILC result reported without these three is incomplete — the
calibration tier's results live or die on whether the measurement model
was honest, and only these displays let the reader check.
