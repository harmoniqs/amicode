# Demo — Command workflows

Step-by-step procedures for the three `/demo` subcommands (`new`, `add`, `review`), plus the
post-solve plotting hook and the autonomous-plan pattern for multi-stage demos. Loaded on
demand from [`../SKILL.md`](../SKILL.md).

## Scaffolding a New Demo (`/demo new <system>`)

When `/demo new <system>` is invoked:

0. **If the demo targets a named device or platform, do the hardware grounding first** —
   the step-0 research, the `PLAN.md` design record, and the stage-0 validation spec per
   [hardware-grounding.md](hardware-grounding.md). Skip for generic-physics demos.
1. Create the `<system>-demo/` repo with the directory structure (see
   [structure.md](structure.md))
2. Create a `Project.toml` with Piccolo, JLD2, Dates, LinearAlgebra,
   SparseArrays as dependencies
3. Stub out each `src/` module with the standard function signatures and TODO comments
4. Create an initial `scripts/single_qubit/optimize_X.jl` as the first gate
5. Create `run_all.jl` scaffold
6. Create `test/test_<system>.jl` with basic system and gate tests
7. Create `docs/` with all four files following the conventions in [docs.md](docs.md)
   (system_model.md, optimization_guide.md, results_summary.md, future_directions.md)
8. Create `README.md` with highlights table (placeholder values), folder structure, getting
   started, and links to docs/
9. Run `cd <system>-demo && julia --project=. -e 'using Pkg; Pkg.instantiate()'` to resolve
   dependencies

**Handoff variant (PLAN.md-first):** when someone else implements the demo, deliver the
scaffolding *without scripts* — directory tree, pinned deps, `PLAN.md`, README, docs stubs —
and register the vault demo card as `status: planned`. See
[hardware-grounding.md](hardware-grounding.md#handoff-pattern-planmd-first).

## Adding a Gate (`/demo add <gate>`)

When `/demo add <gate>` is invoked:

1. Determine if the gate is 1Q, 2Q, or 3Q
2. Add the target gate matrix to `gates.jl`
3. Create `scripts/<category>/optimize_<gate>.jl` following the existing pattern
4. Add the gate to `run_all.jl`
5. Add test items for the new gate in the test file

## Reviewing a Demo (`/demo review`)

When `/demo review` is invoked:

1. Check directory structure matches the layout (see [structure.md](structure.md), including
   `docs/` with all four files)
2. Verify each `src/` module follows the conventions
3. Cross-check against `/setup` rules (min-time strategy, integrator choice, objective
   weights, etc.)
4. Verify tests cover all gates and system configurations
5. Check that `run_all.jl` includes all gates
6. Verify the correct trajectory type is used (see
   [trajectory-and-templates.md](trajectory-and-templates.md))
7. Verify docs follow the conventions: README has highlights + getting started + links;
   system_model has Hamiltonian + parameters; optimization_guide has workflow + tuning;
   results_summary has tables + findings; future_directions has themed extensions
8. Check that results_summary.md is up to date with actual data/ contents
9. Verify free_phase usage: entangling gates with EmbeddedOperator should use
   `free_phase=true`; fidelity reporting distinguishes fixed vs free-phase
10. Verify integrator choice: 3-level / stiff systems use Magnus integrators, not default
    Tsit5
11. Report any missing files, convention violations, or `/setup` rule violations

## Plotting After Solve

After solving at any rung, invoke `/plot rung N gate G path ...` to generate the standard
plot set. Plots are auto-generated between rungs even in unattended agent runs. See the
`/plot` skill for standard plot sets per rung, the upstream candidate protocol for bespoke
code, and platform-specific additions.

## Autonomous Plan Pattern

For complex demos with multiple stages (validation → objective → optimization → analysis),
create a `docs/autonomous_plan.md` that defines:

1. **Staged development** — each stage has concrete deliverables, success criteria, and
   decision points
2. **Skill usage** — which `/skill` to invoke at each stage (e.g., `/setup` before writing
   code, `/solve` for running scripts)
3. **Iteration protocol** — what to check after each optimization (convergence, pulse shape,
   filter function, baseline comparison)
4. **Fail-fast criteria** — when to stop and investigate vs. when to move on

The `nv_center/docs/autonomous_plan.md` is the reference implementation of this pattern. Key
principles:
- **Validate before optimizing**: test against known analytic results (Stage 1) before using
  in optimization
- **Commit working checkpoints**: save results after each stage so progress is never lost
- **Plot everything**: every optimization produces comparison plots
- **Fail fast, diagnose, adapt**: if <5% improvement after tuning, rethink the formulation
