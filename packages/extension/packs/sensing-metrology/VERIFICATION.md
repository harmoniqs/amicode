# Sensing / metrology — the verification contract

Tiered and claim-class-bound (spec-20260920-171500 D4):

| Claim class | Tier | The gate |
|---|---|---|
| Filter-function validation vs synthetic spectra | **T1b** | exit-code + artifact contract: the validation harness compares computed filter response against the declared synthetic ground truth — deterministic over the declared spectra |
| Estimation results (noise spectral density, filter response, with CI) | **T1b** | the estimation payload carries value + lo/hi bounds + the method tag; the CI folds into the ledger as an EstimationResult-class payload |
| Real-testbed claims (NV hardware) | **un-tiered** | synthetic validation certifies NOTHING about the real testbed; the tier appears only when real data is measured |
| Metrology-grade comparisons (cross-method) | **T1b** | reproducible comparison over recorded artifacts; the better method wins on declared metrics, never vibes |

**The re-tiering rule** and the `pre-tier`/retro-labeling discipline: as in
the EE contract (spec-20260920 D4, one rule for every domain).
