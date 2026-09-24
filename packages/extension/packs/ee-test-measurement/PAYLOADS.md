# EE / test-&-measurement — typed payloads

The pack's payload vocabulary (additive; the schema package is the arbiter):

- `measurement-result` — {quantity, value, tolerance, artifact-ref, provenance} — T1b-verified residuals against the recorded artifact
- `calibration-ref-advance` — {ref, parent, config-content-id, per-key-diffs} — the calibration store's content-addressed chain
- `task-record-terminal` — {state, error_kind (script | transport — who fixes them), gates-forwarded, authored_by} — the strumento seam

Every payload carries `tier` (T1a | T1b | T2 | T3 | un-tiered | pre-tier) —
the enum travels with the claim through every render path.
