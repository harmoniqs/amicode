---
name: analyze
description: Post-experiment analysis and insight extraction — stagnation detection, failure classification, hyperparameter comparison. Use after optimization runs to extract patterns and generate insights.
agents: [researcher, librarian, dreamer]
surface: public
project_contract:
  folders: [ledger/observations, ledger/campaigns, scripts/analysis, data]
---

Post-experiment analysis for Amico optimization results.

## Usage

`/analyze` — analyze recent experiment notes and catalog entries for patterns.
`/analyze <platform>` — focus analysis on a specific platform.

## Instructions

### When to Run
After a batch of optimization experiments (3+), or when research direction needs informing (route findings via the D6 rules: survey-shaped → the hopper with a triage tag; intent-direction → the amicissimo proposals surface — agents never edit INTENT).

### Step 1: Gather Data
- Read recent experiment notes in `<project>/ledger/observations/`
- Read catalog entries in `catalog/pulses/*/metadata.toml` if the project has a catalog
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
- **Insight notes**: Create in `<project>/ledger/observations/` when patterns are clear (3+ supporting experiments)
- **Direction suggestions**: Note which direction tiers are progressing vs stalled (from the strategy brief — `amico-run strategy-brief`); route them per the D6 rules (hopper triage tag, or the proposals surface for intent-direction items)

> **Fidelity convention:** Always report both fixed-phase and free-phase fidelity for multi-subsystem gates — free-phase is the primary metric, and fixed-phase can underreport substantially for entangling gates. The `setup` skill owns the canonical statement of this convention (the quantified gap and its reference) — consult it rather than restating it here.

### Quality Bar
- Only generate insights with evidence from 3+ experiments
- Include `confidence: high` only if pattern holds across 5+ experiments
- Always link to specific experiment notes as evidence
