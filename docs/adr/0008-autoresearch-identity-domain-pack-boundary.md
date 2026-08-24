# Amicode is an autoresearch studio; quantum control is a Domain Pack

Amicode's product identity is the autoresearch loop (propose → gate → correct → stage → record), not quantum optimal control specifically. Quantum control is the first and primary Domain Pack — deeply integrated, always-active, the reason most users are here — but the interface (agent identity, UI vocabulary, prompt examples, code structure) must speak the language of autoresearch generically. Domain-specific code is visibly gated behind pack activation rather than scattered invisibly across generic infrastructure.

## Considered Options

1. **Full domain-pack architecture** — polymorphic schemas, pack-dispatched rendering, formal pack registry. Rejected: over-engineered for one pack; no second domain is imminent.
2. **Keep the status quo** — quantum control IS the product, generalization is speculative. Rejected: the coupling creates user confusion (Amicode reads as "a pulse design tool") and blocks the autoresearch identity that is the actual product thesis.
3. **Perception-first cleanup** (chosen) — fix what users and the agent perceive (text, identity, naming, gating) without restructuring packages or adding registries. Domain-specific code stays where it is but becomes clearly labeled and conditionally registered. No new abstractions until a second domain demands them.

## Consequences

- The `CONTEXT.md` identity sentence changes; three new glossary terms (Domain Pack, Substrate, Run) are added.
- AGENTS.md is stripped to persona + the generic research loop; all quantum-control workflow moves to the `solve` skill.
- UI text is generalized ("Run Inspector" not "Pulse Inspector"; generic prompt examples).
- Extension activation, tool registration, and handoff routing gain `if (packActive)` gates — always true today, but the seam is visible.
- The "pulse bank" concept is removed entirely — the widget, the `banked` profile stat, and all prompt injection referencing it. The catalog system (`amico catalog`) already serves this purpose generically; warm-start is a skill concern, not a core surface.
- Schemas and package layout are untouched. The boundary is enforced by developer discipline and code review, not a runtime registry — acceptable until a second pack arrives.
- Risk: without a formal boundary, quantum assumptions can drift back in. Mitigated by the ADR (this document) and the CONTEXT.md vocabulary being the review standard.
