---
name: structural-analysis
description: Predict optimization properties (free-phase, warm-start, stagnation, integrator) from problem specification before running. Invoked from researcher Step 0.5.
agents: [researcher]
surface: public
scenarios: [cz-gate-seed, cz-gate-wrong-family-warm-start]
vault_contract:
  folders: [insights]
---

# Structural Analysis — Pre-Experiment Property Prediction

Given a candidate experiment brief, predict optimization properties to guide hyperparameter selection and risk assessment.

## Process

1. Read candidate brief's `platform` and `gate` fields
2. Run each prediction rule below
3. Return structured analysis as YAML

## Prediction Rules

### Free-Phase Necessity
- If gate ∈ {CZ, CNOT, sqrtiSWAP, CPHASE} or task is state_prep → `free_phase_required: true`
- If single-qubit gate on single subsystem → `free_phase_required: false`
- Evidence: [[insight-20260412-054400-synthesis-free-phase-gap-scales-with-gate-type]]

### Warm-Start Risk
- If brief has `warm_start` field, read source catalog `metadata.toml`
- Compare `N_knots` and `pulse_type` between source and target. If mismatch → `warm_start_risk: grid_mismatch`
- If source catalog entry has no dual variables saved → `warm_start_risk: dual_missing`
- If no warm-start → `warm_start_risk: none`
- Evidence: [[insight-20260412-054500-synthesis-warmstart-failure-taxonomy]]

### Stagnation Risk
- Glob `experiments/` across **every mounted vault** for entries matching this platform and gate
- Count by status field. Compute `failure_rate = count(no_improvement + stagnation) / total`
- If failure_rate > 0.5 AND total >= 3 → `stagnation_risk: high`
- If failure_rate > 0.3 AND total >= 3 → `stagnation_risk: medium`
- Otherwise → `stagnation_risk: low`

### NonlinearDrive GN Hessian Risk
- If system uses NonlinearDrive (e.g., silicon spin J(ε), bosonic displaced-frame):
  - GN Hessian drops O(1) dynamics-constraint terms → cold-start may stall
  - Recommend `eval_hessian=false` (L-BFGS) for Phase 1, exact Hessian for Phase 2
  - `cold_start_hessian_risk: high`
- Otherwise → `cold_start_hessian_risk: none`
- Evidence: [[insight-20260414-030100-dream-gn-objective-hessian-error-vanishes-at-optimum]]

### Integrator Recommendation
- Read system dimension from platform skill or system-context note
- dim ≤ 32 → `integrator: MagnusAdapt4`
- dim > 64 or `hermitian=false` → `integrator: Tsit5`
- Between → `integrator: MagnusAdapt4` with note "consider Tsit5 if stiff"

## Output Schema

```yaml
structural_analysis:
  free_phase_required: true
  warm_start_risk: none|grid_mismatch|dual_missing
  stagnation_risk: low|medium|high
  stagnation_failure_rate: 0.67
  cold_start_hessian_risk: none|high
  integrator: MagnusAdapt4|Tsit5
  notes: "Free text with citations to synthesis insights"
```
