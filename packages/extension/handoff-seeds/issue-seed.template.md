---
kind: {{kind}}
suggested_repo: {{suggested_repo}}
suggested_tier: {{suggested_tier}}
evidence:
{{evidence}}
---

<!-- handoff-seed kind=issue v1 -->

# {{title}}

> [!IMPORTANT]
> **Problem** — {{motivation}}
> **Approach** — Typed handoff from a research campaign; file through the normal issue flow at the suggested tier.
> **Scope** — in: the seeded ask · out: filing agency (the receiving side files it)

## Acceptance Criteria
- [ ] The filed issue carries the seed's evidence pointers, resolved at handoff time

## Prior Art
- Evidence pointers ride the frontmatter `evidence` list; each resolved at validation time.

## Source
- Handoff issue seed, rendered from the committed template.
