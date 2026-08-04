---
name: constraints
description: Add constraints to Piccolo problems — the constraint catalog, where each bound actually lives, and constrain-vs-penalize judgment. Use when a solution violates hardware limits, leaks, or needs a hard fidelity floor.
agents: [researcher, experimenter]
surface: public
scenarios: [cz-gate-leakage-constrained, ignores-stated-constraint]
---

The constraints counterpart to the `objectives` skill. Objectives say what *good* looks
like; constraints say what is *inadmissible*. Both are set at construction time.

## Usage

`/constraints` — reference for constraining Piccolo problems.

The argument is: $ARGUMENTS

## Where each bound actually lives (the three-tier map)

| Physical limit | Where to set it |
|---|---|
| Drive amplitude | `drive_bounds` on the **system** constructor — `QuantumSystem(H_drift, H_drives, [1.0, (−0.5, 0.5)])` (scalar `b` ⇒ `(−b, b)`) |
| Slew rate / smoothness | `du_bound` (and `ddu_bound` on `SmoothPulseProblem`) — template kwargs |
| Timestep / duration | `Δt_bounds = (lo, hi)` — template kwarg; also the lever `MinimumTimeProblem` moves |
| Everything else | explicit constraint objects via the `constraints` kwarg |

Most "I need a constraint" moments are actually one of the first three rows.

## Constraint catalog

**Quantum (Piccolo exports):**

| Constraint | Use |
|---|---|
| `FinalUnitaryFidelityConstraint` | hard fidelity floor on the final unitary (this is what `MinimumTimeProblem`'s `final_fidelity` kwarg installs) |
| `FinalKetFidelityConstraint` / `FinalKetFreePhaseConstraint` | same for state transfer (fixed / free-phase) |
| `FinalCoherentKetFidelityConstraint` | multi-ket gate problems (auto-dispatched by `MinimumTimeProblem` for `MultiKetTrajectory`) |
| `FinalDensityFidelityConstraint` | density-matrix problems |
| `LeakageConstraint` | hard cap on leakage population (see below) |
| `BoundStateL2Constraint` | bound the state norm on selected components |

**Generic (DirectTrajOpt exports):** `EqualityConstraint`, `BoundsConstraint`,
`NonlinearKnotPointConstraint`, `NonlinearGlobalConstraint`, `TimeConsistencyConstraint`,
`L1SlackConstraint`.

**Attach at construction** — every template takes `constraints::Vector{<:AbstractConstraint}`:

```julia
qcp = SplinePulseProblem(qtraj; constraints = AbstractConstraint[my_constraint])
```

> Note: `add_objective!` / `add_constraint!` post-construction mutation is **not in
> released Piccolo** (feature-branch only). On current releases, pass `constraints`
> (all templates) and `extra_objectives` (`SplinePulseProblem`) at construction, and
> rebuild the problem to change them. `display(qcp)` shows what a problem carries.

## Leakage: constrain or penalize?

For an `EmbeddedOperator` goal the leakage levels are known
(`get_leakage_indices(op)`); templates accept `state_leakage_indices` to wire them.

- **Penalize** (`LeakageObjective`, or leakage settings in `PiccoloOptions`) when leakage
  is a soft trade-off — the optimizer balances it against fidelity. Start here.
- **Constrain** (`LeakageConstraint`) when a spec must hold (e.g. "< 10⁻⁴ population
  outside the qubit subspace") — but a tight hard cap on a cold start is often
  infeasible; solve with the penalty first, then re-solve warm-started with the
  constraint (see `compose` P4).

The same judgment applies generally: **penalty first, constraint after warm-start** is
the robust order for any hard nonlinear requirement, including fidelity floors —
which is exactly why `MinimumTimeProblem` comes *after* a fidelity solve.

## Diagnosing constrained solves

- `display(qcp)` — lists equality/bounds/nonlinear constraint counts and objective terms.
- Ipopt's `inf_pr` column is primal infeasibility: it must reach ~1e-6 by convergence.
  A solve that "converges" with large `inf_pr` did not satisfy your constraints.
- Infeasible-from-the-start usually means bounds fight each other (seed outside
  `drive_bounds`, `Δt_bounds` excluding the seed's timesteps, fidelity floor above the
  warm start's fidelity). Check the seed against every bound before blaming the solver.

## Rules

1. Set amplitude limits on the **system**, not with ad-hoc constraint objects.
2. Hard constraints go on **warm-started** problems; penalties go on cold ones.
3. `final_fidelity` floors come from *verified* fidelities minus margin (see `compose`).
4. After any constrained solve, verify the constraint held in the independent rollout
   (`simulate`) — e.g. recompute leakage from the rolled-out states, not the optimizer's.

## Next steps

`objectives` (the soft counterpart), `problem-types` (which template takes which kwargs),
`compose` (penalty→constraint staging), `simulate` (post-solve verification).
