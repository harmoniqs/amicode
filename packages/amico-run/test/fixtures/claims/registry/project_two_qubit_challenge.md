---
type: insight
statement: Two-qubit gates (SWAP, CX, CZ) on coupled qubits are significantly harder than single-qubit gates
status: unverified
confidence: medium
evidence:
  - memory-card/project_two_qubit_challenge.md
applied: 0
last_applied: null
history:
  - date: 2026-10-02T12:00:00.000Z
    event: projected
    note: "projected from memory card project_two_qubit_challenge.md (card type: project) by amico claims project — the #1681 mechanical migration of the memory namespace into claims"
scope: personal
tags:
  - memory
  - two-qubit
---

# Two-qubit gates (SWAP, CX, CZ) on coupled qubits are significantly harder than single-qubit gates

Claim of the `claims` registry — projected from the memory card
`amicode/memory/project_two_qubit_challenge.md` by `amico claims project` (amicode #1681).
The original card is preserved verbatim below; the claim object above is the
machinery surface — its lifecycle (corroborate / supersede / refute) is stamped
by the flywheel's passes, never by hand.

## Original card — frontmatter (preserved verbatim)

```yaml
name: two-qubit-gate-challenge
description: Two-qubit gates (SWAP, CX, CZ) on coupled qubits are significantly harder than single-qubit gates
type: project
date: 2026-07-13
tags: [memory, two-qubit]
status: active
```

## Original card — body (preserved verbatim)

The Jul 3–13 campaign revealed a sharp difficulty cliff between single-qubit
and two-qubit gates.

**Why:** Single-qubit X and T gates reliably achieve $F > 0.9999$. In contrast:
- SWAP on a coupled pair: best $F = 0.9996$ at three times beyond $T_2$
- CX: best $F = 0.25$ (essentially random)
- Cθ, CZ, iSWAP: all failed to produce results

**How to apply:** Two-qubit gate problems need more optimization effort: longer
gate times, more knot points, potentially different integrators, and careful
decoherence modeling. Consider breaking into sub-problems.

