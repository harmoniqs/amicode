---
name: altissimo
description: Altissimo.jl — the matrix-free NLP solver beneath Piccolissimo's spline problems. The ρ-schedule doctrine (default ladder, caps, the :demand policy and its measured limits), the churn signature, warm-start rules, and which knobs actually bind. Use when tuning, warm-starting, or diagnosing stalls and churn on Altissimo solves.
surface: entitled
entitlement: issimo
revision: 2
---

# Altissimo — solver tuning & diagnosis

Altissimo is the augmented-Lagrangian NLP solver (trust-region + ceiling-bound
CG inner solves) that Piccolissimo's spline problems ride on the matrix-free
backend. It is CPU-native and array-generic. This skill is the measured
doctrine: every claim below is banked evidence from paired multi-seed
experiments — not theory.

## The ρ schedule — the biggest single lever, and its honest limits

Altissimo's penalty schedule ρ controls feasibility absorption AND CG
conditioning (κ ∝ ρ → CG iters ∝ √κ) — it is the largest performance knob in
the solver. The measured facts (10-seed paired batteries):

| Recipe | Measured behavior |
|---|---|
| **Default ×10 ladder** | Works but churns: ρ = ρ_max by outer ~6, then the tail runs at max conditioning with feasibility parked ~1e-2 and the merit function churning in penalty terms. Descends anyway on most shapes. The safe default. |
| **Capped ρ (ρ_max ≲ 1e3)** | STARVES feasibility on every arm, cold and warm — inf_pr freezes at the x₀ violation level. Warm-start preservation under a cap does NOT transfer to cold absorption. If a cap is ever wanted, the (untested) value class is 1e4–1e5. |
| **`adaptive_ρ` + cap** | The measured WORST case: multipliers pinned at ‖λ‖ = 0 from x₀, total starvation. Never. |
| **`ρ_policy = :demand`** | Escalates ONLY on stale trailing inf_pr windows (feasibility progress, never dual norms); holds on progress rung-by-rung; `:default` is bit-identical. Oracle-measured 25–33% fewer HVPs on contrived carriers. **Validated MIXED on real problems**: the policy behaved as designed everywhere (strictly fewer escalation rungs, zero starvation), but the efficiency did not cash out in rollout fidelity on most real shapes at real budgets. Expect holds, not miracles; measure on YOUR shape. |

Knob facts: `AltissimoOptions`' `ρ_max` default is 1e6 (the raw path's 1e8) — at
pinned options the era is floor-AND-ceiling.

## The churn signature (know it when you see it)

Warmup→AL-entry churn: early outers ride INFEASIBILITY (low J that is NOT a
solution), the ρ ladder then re-inflates J (0.15→75 unitary; 0.02→400 at K=4),
and the post-churn phase parks far from any convergence bar. It is a **policy
artifact** (cold duals + the default ladder), not a physics limit. Two
consequences:

- **Never trust raw J in the churn window** — it literally rewards passing
  through infeasible states. Score progress on **rollout-truth fidelity**, and
  expect the early low-J readings to be lies. (Measured: an arm's raw J read 255
  while its rollout truth was 404.)
- **A plateau at smoke budget is budget, not physics** — verify at real budgets
  on real problems before concluding anything.

## Warm-starting Altissimo — the AL-entry laws

- **Never carry mid-churn duals (λ0/μ0) without the matching ρ era.** Bare
  dual handoff DIVERGES — measured f_val → −1.2e18; the λᵀc term dominates by
  five orders of magnitude. The entry state must carry the PENALTY ERA, not just
  the multipliers.
- **The entry state changes the PATH, not the PARKING.** All four measured entry
  variants (cold zero-duals / x-only / duals-carried / duals+era-carried) park
  at the SAME plateau. Warm-starting the optimizer entry is not a fidelity lever.
- **The de-facto resume is a cold restart** — resuming a solve from its own
  iterate behaved identically to cold entry, everywhere measured.
- **State warm-starts ARE the lever**: seed knot states via
  `set_state_guess!(qcp, states; respect_initial = true)` (Piccolissimo) — 9/10
  seeds better rollout fidelity at 2.5–26× fewer HVPs. **Never cap ρ under an
  infeasible seed.**
- **λ0/μ0 API facts** (when you do pass duals): the kwargs take UNSCALED duals;
  the result ALIASES optimizer buffers — copy before reusing.

## What actually binds (stop turning dead knobs)

- **Inner solves are TR-bound (79–100% of outers) and ceiling-bound; the
  tolerance essentially never binds** (measured 0/707 `residual_met`).
  Tolerance-side tricks and forcing schedules have no traction in this family.
  The levers that matter: the ρ schedule and the preconditioner.
- **The assembled/probed Gauss–Newton preconditioner is DEAD on routed-Unitary
  shapes** — measured 52–79× more matrix-vector products at 5× wall (a
  regression, not a rescue). Do not reach for it there.
- **L-BFGS line-search / scale / memory knobs are dead on the creep defect** —
  see "L-BFGS step-length creep" (next section); the lever there is a code fix, not a knob.
- **Dual resets are real and telemetered** — duals get eaten and reset on a
  measurable fraction of long runs; expect resets in any long solve; don't
  mistake a reset for a crash.

## L-BFGS step-length creep — known defect, fix PENDING MERGE (not in main)

**Status: pending merge.** A candidate fix is in draft review as
harmoniqs/Altissimo.jl#450 ("Powell damping test against the model curvature").
Until a human merges it, treat everything below as a *known defect with a
proposed fix*, not as behavior that has been corrected in any release. The PR's
own reported test deltas are author-reported and unreviewed.

**Symptom** (measured on a 96-control reduced-space fixture, three perturbed
starts, `LBFGS(memory_size = 10)` + `StrongWolfe`, unconstrained):

- α = 1 on 81–92% of line-search results, with a *median step length of order
  1e-4* (‖αd‖ ≈ 1.6e-4 – 4.0e-4), i.e. the solver creeps.
- 1.2–1.3 oracle evaluations per iteration — so the shortfall is progress per
  iteration, **not** line-search cost.
- **2–3× more unique oracle evaluations than a plain Optim.jl L-BFGS(m = 10,
  HagerZhang)** on the same x-keyed counted oracle: Optim reached the target in
  52–69 unique evals; Altissimo was still short at the 150-eval cap on all three
  starts (so the gap is a lower bound, ≥ 2.2–2.9×).

**Diagnostic** (do this before blaming the problem):

1. Run Optim L-BFGS and Altissimo L-BFGS from the same start on a *counted*
   oracle — cache keyed on x, count unique evals, never calls — and compare
   unique evals to a common target. A ≥ 2× gap with Altissimo at α = 1 and tiny
   ‖αd‖ is this signature.
2. Read the per-iteration line-search rows (`verbose_inner = true`): α, ‖αd‖,
   evals per iteration.
3. The root cause identified in the ablation was that the Powell-damping safeguard
   fired on ≈ 59–64% of accepted pairs that already had positive curvature
   (yᵀs > 0, as Wolfe guarantees), inflating the stored curvature along s by a
   median ≈ 6.5–6.9×. **Counting firings required a scratch-copy
   instrumentation; no shipped telemetry counter is claimed here (unverified).**

**What was and was not tested** (one fixture, one Altissimo tree
`243850c`; the second, larger fixture was *not* run):

- Dropping the damping safeguard (`powell_damping = false` on the LBFGS
  constructor) closed the gap on that fixture (median closure ≈ 1.03), and
  disabling the initial-Hessian scaling (`H0_scale = false`) closed it
  further. Both are **diagnostic switches, not recommendations**: they change
  the default for every L-BFGS user, including the NewtonCG preconditioner and
  the trust-region path, which were not tested. Smoke-test the kwarg names on your
  Altissimo version before relying on them (unverified outside that tree).
- Nothing else closed it: line-search constants (c1), `α_max`, memory size
  (9/11/20), swapping StrongWolfe for backtracking, a reset on line-search
  failure, a first-step guess, and problem scaling each closed 0 of the gap.
  See "What actually binds" — these are dead knobs here too.

**Do not read this as "Altissimo is slow".** The defect is in the quasi-Newton
history update that every Altissimo L-BFGS user shares; it says nothing about the
augmented-Lagrangian path on constraint-dense collocation problems, which this
fixture did not exercise. For *which* solver form to use on a reduced-space
problem, see the `tool-selection` card.

Provenance: personal-vault insight `insight-20261106-optimizer-experiments-batch1`
(item 1) and experiment notes `experiment-20261106-h3-s0` / `-h3-s1`
(2026-11-06); all J values in those notes are UNCERTIFIED design-truncation
values on the optimized oracle; the evidence is evals-to-target, not fidelity.

## Comparing two configurations honestly

- **Paired per-seed comparisons** — never compare across seeds; sign
  consistency across the pair is the evidence.
- **Never conclude from the ordering of two capped-budget arms** — the end-value
  ordering flips with runner numerics (measured: one draw flipped a 1.6× ratio
  to 2.3×). Run each arm to its own convergence bar, or compare both at
  multiple budgets.
- **Rollout truth is the only fidelity gate** — stored-terminal infidelity is
  gameable through infeasible states.
