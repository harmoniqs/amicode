---
name: objectives
description: How objectives compose, evaluate, and update in Piccolo problems. Use when adding/swapping objective terms, debugging an unexpected J(x₀), or implementing a new objective type.
agents: [experimenter, engineer]
surface: public
provides_helpers: [unitary_fidelity_loss, U_goal, z]
scenarios: [cz-gate-leakage-constrained]
---

# Objectives in Piccolo

The objective in a `QuantumControlProblem` lives at `qcp.prob.objective` and is a `CompositeObjective` — a flat list of sub-objective terms with scalar weights. Every term is independently callable on a `NamedTrajectory`, which is what lets the rich `display(qcp)` show the per-term breakdown.

## When to use this skill

- Adding a regularizer or penalty term (`extra_objectives` at construction)
- Picking among the many fidelity flavors (Unitary/Ket/Density × FreePhase/Fixed × Multi/Sampling)
- Debugging an unexpected `J(x₀)` line in `display(qcp)`
- Implementing a new objective term in Piccolo

## The composite structure

```julia
J = qcp.prob.objective                      # ::CompositeObjective
J.objectives                                # Vector{AbstractObjective}
J.weights                                   # Vector{Float64}
J(traj)                                     # total at current trajectory point
J.objectives[k](traj)                       # per-term value (Q baked in)
```

`+` flattens: `(a + b) + c` becomes a 3-term composite, not a tree. Each term is a struct (no closures), evaluated via multiple dispatch.

## Inspecting at runtime

`display(qcp)` (or `show_problem(qcp)`) shows the breakdown:

```
├─ Objective   total = 9.195e−04  @ current x
│    GlobalKnotPointObjective    w=1   5.916e−05    ← the (Free-phase) infidelity
│    QuadraticRegularizer(:u)    w=1   8.604e−04    ← u smoothness
│    QuadraticRegularizer(:du)   w=1   0
│    NullObjective               w=1   0
│    MinimumTimeObjective        w=1   1.722e+05    ← duration cost
```

- The `w=` column is the *outer* CompositeObjective weight (almost always 1 — set by `α * J` style scaling, rarely used).
- The right-hand value is the term's own `Q`-weighted contribution; that's the actual J_i(x).
- "@ current x" — always reflects `qcp.prob.trajectory`. Before solve: initial guess. After solve: optimum.

## Catalog of Piccolo objective types

Defined in [`Piccolo.jl/src/control/objectives.jl`](Piccolo.jl/src/control/objectives.jl). Each wraps a base `DirectTrajOpt` objective (TerminalObjective / KnotPointObjective / GlobalKnotPointObjective).

| Type | Use case | Phase-free | Wraps |
|------|----------|------------|-------|
| `UnitaryInfidelityObjective` | gate | no | `TerminalObjective` |
| `UnitaryFreePhaseInfidelityObjective` | gate, Z-phase free | yes | `TerminalObjective` w/ globals |
| `KetInfidelityObjective` | state transfer | no | `TerminalObjective` |
| `KetFreePhaseInfidelityObjective` | state transfer | yes | `TerminalObjective` w/ globals |
| `CoherentKetInfidelityObjective` | gate via ket ensemble | no | `TerminalObjective` |
| `CoherentKetFreePhaseInfidelityObjective` | gate via ket ensemble | yes | `TerminalObjective` w/ globals |
| `DensityMatrixInfidelityObjective` | open-system fidelity | no | `TerminalObjective` |
| `DensityMatrixPureStateInfidelityObjective` | open-system state prep | no | `TerminalObjective` |
| `LeakageObjective` | soft leakage penalty | n/a | `KnotPointObjective` (per-knot) |
| `UnitarySensitivityObjective` | robust gate | no | `TerminalObjective` |

And from DirectTrajOpt itself:

| Type | Use case |
|------|----------|
| `QuadraticRegularizer` | L2 penalty on a control component |
| `MinimumTimeObjective` | ∑Δt cost |
| `NullObjective` | identity element of `+` |

## Free-phase pattern

`*FreePhase*` objectives carry phase variables (`φ_*`) as **global trajectory components** and slice them out of the augmented state vector inside the cost closure:

```julia
function ℓ(z)
    Ũ⃗, θ = z[1:(end-d)], z[(end-d+1):end]
    return abs(1 − QuantumObjectives.unitary_fidelity_loss(Ũ⃗, U_goal(θ)))
end
return TerminalObjective(ℓ, Ũ⃗_name, θ_names, traj; Q = Q)
```

`U_goal(θ)` is a closure built by `_make_free_phase_goal(::EmbeddedOperator)` that applies `Z(θ_1) ⊗ Z(θ_2) ⊗ …` to the base goal. The optimizer drives both `Ũ⃗` and `θ` to minimize the infidelity — free-phase fidelity is what the constraint actually enforces, not raw F.

## Naming gotcha — `unitary_fidelity_loss` returns F, not the loss

```julia
unitary_fidelity_loss(Ũ⃗, U_goal)   # ← returns F (the fidelity), despite the name
abs(1 - unitary_fidelity_loss(Ũ⃗, U_goal))  # ← this is the loss/infidelity
```

Same trap with `ket_fidelity_loss`. Every Piccolo objective wraps the call as `abs(1 - …_fidelity_loss(…))` to get the infidelity. If you copy a snippet and skip the `abs(1 - …)`, you'll minimize the *fidelity* (broken in the obvious way). This bit the rich-display code — be careful in any new objective.

## Adding terms to a problem

On **released Piccolo (≥ 1.19)**, objective terms are supplied at construction time:
`SplinePulseProblem` takes `extra_objectives::Vector{<:AbstractObjective}`; every
template takes `constraints::Vector{<:AbstractConstraint}` (see the `constraints` skill).
To change terms, rebuild the problem (cheap — the trajectory carries the state):

```julia
# A custom regularizer supplied at construction (any AbstractObjective works)
extra = AbstractObjective[my_regularizer]
qcp = SplinePulseProblem(qtraj; extra_objectives = extra)
display(qcp)   # the per-term breakdown reflects what the solver actually sees
```

Only `SplinePulseProblem` takes `extra_objectives` today — `SmoothPulseProblem` and
`BangBangPulseProblem` do not. If you need an extra term on those, either fold it into a
constraint or shape the problem through the kwargs it does expose; do not assume parity.

> `add_objective!(qcp, term; redisplay=…)` / `add_constraint!(qcp, c)` post-construction
> mutation exists only on unreleased feature branches (`feat/operator-fusion`). Do not
> teach or use it against a released Piccolo — it `MethodError`s. If it lands on main,
> this section flips back to the mutating idiom.

## Debugging an unexpected J(x₀)

Read the per-term breakdown in `display(qcp)`. The actionable patterns:

| What you see | What it usually means |
|---|---|
| Fidelity-term value ≫ regularizer values | dynamics violated at x₀ — solver hasn't converged. Check the `BilinearIntegrator` / `SplineIntegrator` row in Constraints — `‖c‖∞` should be ~1e−6 at optimum. |
| `MinimumTimeObjective` ≫ everything else | Δt × N dominates and crowds out fidelity. Lower `D` or shorten `T_init`. |
| `QuadraticRegularizer(:du) ≈ 0` | du is identically zero — either a cold start with `du_init=0`, or a `LinearSplinePulse` where `du` is constrained to `(u[k+1]-u[k])/Δt`. |
| `LeakageObjective` non-zero | population is leaking outside the computational subspace; tighten `leakage_cost` or add `LeakageConstraint`. |
| `F (raw) ≪ F (with φ)` | the optimizer found a great unitary up to a Z-rotation; you're getting the benefit of `free_phase=true`. |

Always read both fidelity lines in the Status section:

```
F (raw)       = 0.725128
F (with φ)    = 1.000000     ← what the constraint enforces
```

A large gap is *good* if `free_phase=true` — it means the optimizer is taking advantage of single-qubit Z calibration freedom.

## Implementing a new objective

A new objective is a struct with a callable method `(obj::MyObj)(traj::NamedTrajectory)::Real` plus a `gradient!` (in-place) for solver use. Concrete patterns:

- **Terminal-only cost** (acts on a single knot): build via `TerminalObjective(ℓ, name, traj; Q)`. Examples: every `*InfidelityObjective`.
- **Per-knot cost** (sums across knots): build via `KnotPointObjective(ℓ, name, traj; Qs)`. Example: `LeakageObjective`.
- **Cost depending on globals** (phases, calibration knobs): build via `TerminalObjective(ℓ, name, global_names, traj; Q)`. The cost receives `z = [state; globals]`. Example: every `*FreePhase*` objective.
- **Cost spanning all knots + globals**: `GlobalKnotPointObjective`.

Always wrap your scalar with `abs(1 - …)` if you're using a `*_fidelity_loss` helper — those return F, not 1−F (see naming gotcha above).

Place new Piccolo objectives in `Piccolo.jl/src/control/objectives.jl`, export from `QuantumObjectives`, and add a `@testitem` block in the same file. Regularizers that depend on a specific integrator's internal structure (e.g. spline bending energy) belong with that integrator, not in the public objective set.

## Cross-references

- [`piccolo-dev`](../piccolo-dev/SKILL.md) — Piccolo.jl module tree, where files live
- [`setup`](../setup/SKILL.md) — script-level patterns for assembling problems
- [`solve`](../solve/SKILL.md) — calling `solve!` with the right verbose / print_level / hessian flags
