# Confidence rubric (canonical) — L1 recommendations & L2 Veloce

This is the SINGLE source of truth for how Amico scores a recommendation's
confidence. Both the interview (L1) and Veloce (L2) read THIS file — never
restate the numbers elsewhere, so the two can't drift.

A recommendation is `{param, value, confidence, provenance:[{source,ref,note}]}`.
`confidence ∈ high | medium | low`, keyed to **provenance type** (mechanical),
never to model judgment.

## Resolution order (pick the highest available, then score it)

1. **own-precedent** — a `## Your recent problems` card matching the full 3-tuple
   `(platform, problem_kind, target)`. A match is a _candidate_; score by §high.
2. **demo** — a `## Reference demos` card matching the full 3-tuple → **medium**.
3. **physics** — the platform skill's canonical value (speed limit, cutoff
   sizing) → **medium**.
4. **default** — the SCORE.md static default → **low**.

## The `high` predicate (own-precedent only, mechanical)

A candidate own-precedent card scores **high** iff:

- `platform`, `problem_kind`, `target` all equal, AND
- **every gating scalar for the platform** matches within tolerance (below), AND
- for a **warm-start** rec additionally: the card's `pulse_ref` resolves to a
  `pulse.jld2` that **exists on disk** (stat it before labeling).

Otherwise → **medium** (same problem, different regime / missing data / missing
pulse). A bare 3-tuple match is NEVER high on its own.

### Gating scalars + tolerances (per platform)

| Platform         | Gating scalars (tolerance)                                                        |
| ---------------- | --------------------------------------------------------------------------------- |
| transmon         | `levels` (exact), `drive_max` (±10%)                                              |
| cavity / bosonic | `fock_cutoff` (exact), `chi` (±10%), target `alpha` or Fock index (exact)         |
| atoms (Rydberg)  | `levels` (exact), `rabi_max` (±10%), `delta_max` (±10%), distance/blockade (±10%) |

**Fail-safe:** a platform NOT listed here, or a card missing any required
`sys_params` field, scores **medium, never high**. Unknown regime → fail safe.

`±10%` means `|a − b| ≤ 0.10 × max(|a|, |b|)`.

## medium / low

- **medium**: demo (3-tuple), physics-canonical, or an own-precedent 3-tuple
  match failing the `high` predicate.
- **low**: heuristic / extrapolated / static default with no matching precedent
  or physics anchor. Always say it's a heuristic.

## L2 (Veloce) consumes this

Veloce auto-accepts iff `confidence == high` AND the decision is a reversible
interview parameter (never a resource gate). medium/low always ask. Because
`high` is the mechanical predicate above, auto-accepting it re-uses a decision
the user already made — not a new bet.
