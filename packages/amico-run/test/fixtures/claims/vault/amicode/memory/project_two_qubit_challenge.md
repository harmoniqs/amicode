---
name: two-qubit-gate-challenge
description: Two-qubit gates (SWAP, CX, CZ) on coupled qubits are significantly harder than single-qubit gates
type: project
date: 2026-07-13
tags: [memory, two-qubit]
status: active
---

The Jul 3–13 campaign revealed a sharp difficulty cliff between single-qubit
and two-qubit gates.

**Why:** Single-qubit X and T gates reliably achieve $F > 0.9999$. In contrast:
- SWAP on a coupled pair: best $F = 0.9996$ at three times beyond $T_2$
- CX: best $F = 0.25$ (essentially random)
- Cθ, CZ, iSWAP: all failed to produce results

**How to apply:** Two-qubit gate problems need more optimization effort: longer
gate times, more knot points, potentially different integrators, and careful
decoherence modeling. Consider breaking into sub-problems.
