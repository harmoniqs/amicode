# Sensing / metrology — typed payloads

- `estimation-result` — {quantity, value, lo, hi, method, artifact-ref, provenance} — the CI-folding payload (the EstimationResult class)
- `validation-verdict` — {claim, tier (T1b), ground-truth-ref, delta, tolerance} — the synthetic-spectra comparison
- `filter-function-artifact` — {family, parameters, response-array-ref, sha} — the computed response, content-addressed

Every payload carries `tier` — the enum travels with the claim (un-tiered
for real-testbed claims until measured; pre-tier for historical records).
