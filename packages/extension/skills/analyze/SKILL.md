---
name: analyze
description: Post-experiment analysis and insight extraction — stagnation detection, failure classification, hyperparameter comparison. Use after optimization runs to extract patterns and generate insights.
agents: [researcher, librarian, dreamer]
surface: public
vault_contract:
  folders: [experiments, insights]
  catalog: [pulses]
---

Post-experiment analysis for Amico optimization results.

## Usage

`/analyze` — analyze recent experiment notes and catalog entries for patterns.
`/analyze <platform>` — focus analysis on a specific platform.

The argument is: $ARGUMENTS

## Instructions

### When to Run
After a batch of optimization experiments (3+), or when STRATEGY.md priorities need updating.

### Step 1: Gather Data
- Read recent experiment notes in `experiments/` across **every mounted vault** (read precedence per the `amico-vault` skill)
- Read catalog entries in `catalog/pulses/*/metadata.toml` from whichever mount holds the catalog
- Group by (platform, gate) pairs

### Step 2: Stagnation Detection
Flag stagnation when:
- >5 experiments at same (platform, gate) with <0.01% fidelity improvement
- Same `failure_mode` recurring across attempts
- Warm-start chains that plateau after first iteration

Report: "Platform X, Gate Y appears stagnant — N attempts, best fidelity F, failure mode M"

### Step 3: Failure Mode Classification
For each non-improving experiment, classify failure_mode:
- **stagnation**: optimizer converged but below target (gradient norm small, fidelity flat)
- **divergence**: optimizer blew up (NaN, Inf, inf_pr explosion)
- **constraint_violation**: feasibility error (amplitude bounds, slew rate)
- **infeasible**: problem appears overconstrained (no feasible solution found)

### Step 4: Hyperparameter Comparison
Compare across experiments for the same (platform, gate):
- N_knots: which knot count works best?
- pulse_type: cubic vs linear performance
- Q / R_u / R_du: does tuning help?
- Integrator: Tsit5 vs Magnus performance

### Step 5: Warm-Start Lineage Analysis
Trace chains via `warm_started_from` in catalog:
- Productive chains: sustained fidelity improvement across versions
- Stuck chains: plateau after first warm-start
- Flag chains where cold restart might beat continuing

### Step 6: Generate Outputs
- **Insight notes**: Create in `<vault>/insights/` (route per amico-vault) when patterns are clear (3+ supporting experiments)
- **Strategy suggestions**: Note which STRATEGY.md priorities are progressing vs stuck
- Use `/amico-vault` skill for correct frontmatter

> **Fidelity convention:** Always report both fixed-phase and free-phase fidelity for multi-subsystem gates. Free-phase is the primary metric. Fixed-phase routinely underreports by 6–80 pp for entangling gates. Ref: [[insight-20260412-054400-synthesis-free-phase-gap-scales-with-gate-type]].

### Quality Bar
- Only generate insights with evidence from 3+ experiments
- Include `confidence: high` only if pattern holds across 5+ experiments
- Always link to specific experiment notes as evidence
