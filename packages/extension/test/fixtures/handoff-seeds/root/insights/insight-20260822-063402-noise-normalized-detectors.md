---
type: insight
date: 2026-08-22
source: experiment
evidence: []
confidence: high
tags: [insight, detector, multistart]
---

# Onset and inversion detectors compose; thresholds do not transfer

The onset detector (curvature of the fidelity series) and the inversion
detector (sign flip of the trend) compose cleanly, but a threshold tuned on the
onset detector misfires when reused for the inversion detector — each wants its
own noise-normalized calibration. The multistart cascade dispatched twice on
runs that had not in fact stagnated.
