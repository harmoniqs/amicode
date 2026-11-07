---
type: insight
statement: An unresolvable evidence pointer is drift a human must resolve
status: unverified
confidence: low
evidence:
  - memory-card/gone_card.md
applied: 0
last_applied: null
history:
  - date: 2026-09-07T08:00:00.000Z
    event: projected
    note: "projected from memory card gone_card.md (curation fixture, #1685)"
scope: personal
tags:
  - stale
---

# An unresolvable evidence pointer is drift a human must resolve

Curation fixture (amicode #1685): the claim's evidence pointer names a memory
card that does NOT exist in the vault fixture — the prune job's schema-check
(the claims lint, reused verbatim) must flag it as DRIFT for a human, and the
pass must never "fix" it by deleting the pointer (that would be a guess).
