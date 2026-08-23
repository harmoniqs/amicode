---
type: insight
date: 2026-08-22
source: experiment
evidence: []
confidence: medium
tags: [insight, detector, stagnation]
---

# Detector thresholds want noise normalization

The stagnation detector fired on three runs that were still improving: the raw
fidelity-delta threshold sits below the run's own noise floor, so ordinary
iteration noise reads as a plateau. Normalizing the threshold by the rolling
fidelity variance separated the true plateaus from the noise in every replayed
run.
