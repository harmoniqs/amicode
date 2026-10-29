# EE / test-&-measurement — the verification contract

Tiered and claim-class-bound (spec-20260920-171500 D4): a tier tag asserts
what the instrument establishes, never more.

| Claim class | Tier | The gate |
|---|---|---|
| Measurement residuals (recorded artifact vs model, declared tolerance) | **T1b** | deterministic given the recorded artifact — the measurement is stochastic, the residual check over the recorded artifact is not; tolerance declared per contract, residuals honestly noise-bounded |
| Closed-loop recalibration (the measure → believe → measure-again chain) | **T1b** | the calibration store's content-addressed chain: each ref advance re-derived from the record, never self-graded |
| Hardware claims (real instruments) | **un-tiered** | mock runs certify NOTHING about hardware — the tier appears only when real instruments are measured; the scope bound holds |
| Bringup state (device model vs manifest) | **T1b** | the strumento device-schema validation (typed errors, `ok: false` carries the error class) |

**The re-tiering rule:** upgrade on new mechanical evidence (provenance
stamped); downgrade/quarantine when an instrument is invalidated, cascading
to the claims it certified. Historical records render `pre-tier` with
provenance until retro-labeled via the deterministic class→tier table.

**The task-record contract is the trust boundary:** the directory is the
truth; verdicts forwarded from gates are re-derived from the record before
routing; only declared gates forward at all; forwarding requires a
non-empty `authored_by`.
