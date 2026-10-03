---
type: best-practice
statement: Pin the global model parameters before co-optimizing on a first solve
status: corroborated
confidence: high
evidence:
  - memory-card/reference_rho_policy.md
applied: 2
last_applied: "2026-05-01T08:00:00.000Z"
history:
  - date: 2026-04-01T08:00:00.000Z
    event: created
    note: "the pin-globals-first doctrine as first stated (fixture, #1684)"
  - date: 2026-05-01T08:00:00.000Z
    event: applied
    note: "adopted on a first-solve recommendation (fixture, #1684)"
scope: personal
tags:
  - solver-doctrine
---

# Pin the global model parameters before co-optimizing on a first solve

Lifecycle fixture (amicode #1684): the DECAY candidate — applied twice, but
not since 2026-05-01, which is beyond the 90-day window at the fixture
clock (2026-10-02): the pass must PROPOSE it for review (queue), never
delete it and never change its status.
