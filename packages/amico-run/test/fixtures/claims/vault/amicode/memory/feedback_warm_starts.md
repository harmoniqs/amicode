---
name: warm-starts
description: "STATE warm-starts beat control-only warm-starts (B3 10-seed: 9/10 better, 2.5–26x fewer HVPs); gate on rollout truth only"
type: feedback
date: 2026-08-14
tags: [memory, warm-start]
status: active
---

Warm-starting the optimizer STATE (not just the controls) reliably beats
control-only seeding. Never cap rho under an infeasible seed.

**Why:** The B3 10-seed study: 9/10 seeds better, 2.5–26x fewer HVPs.

**How to apply:** Seed the full state guess via set_state_guess!; accept the
result only on rollout-truth fidelity, never the optimizer's own objective.
