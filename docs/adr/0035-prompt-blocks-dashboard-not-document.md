---
status: proposed
schema_version: "1"
spec_id: adr-0035-prompt-blocks-dashboard-not-document
date: 2026-10-21
session_id: session-20261021-rd-system-v2
priority: p1
task_type: implement-slice
tags: [adr, prompt, blocks, context, named-outcome, system-context]
assumptions:
  - "The per-prompt plugin transform (stack_state.ts's seam) remains the delivery path for live amicode sessions; the V2 session core's epoch reconcile is the second renderer."
  - "Block sources are files or routes the generator can read cheaply per prompt build (vaults, dashboards, telemetry freshness, the mode registry)."
acceptance:
  - "block_registry_declares_all_blocks == 1"
  - "silent_degrade_paths == 0"
  - "block_size_budget_enforced == 1"
---

# ADR 0035 — The prompt is a dashboard, not a document

The system prompt gains a **Block registry**: context enters as generated, TTL-stamped, size-budgeted blocks composed per prompt build — never as hand-maintained prose sections. We chose this over static AGENTS.md sections (staleness invisible), per-turn whole-prompt rewrites (prompt instability, no anchors), and widget-only surfacing (the session itself never sees the state it runs on). Blocks **never degrade silently**: missing/stale/failing renders a **Named outcome** line (the reason class + timestamp), the discipline the boot-frozen-skills and telemetry-dead-4-weeks incidents both lacked. **TTL derives from the source itself** — the payload's own timestamp, the file's mtime, the route's freshness field — never a declared constant, so a stale source renders as stale however the registry is configured; the named outcome carries the source's *measured* age. Named outcomes are **change-detected**: a transition (new failure class, age crossing a threshold) surfaces once through the boundary machinery; a persistent failure renders one stable line with growing age — never unread perpetual noise (the 215-alarm class). Block definitions live once in the registry with two renderer bindings — the plugin's per-prompt transform (ships first, where sessions run today) and a V2 `SystemContext` source per block (epoch reconcile: baseline at session start, `ContextUpdated` mid-session; staging churn moves a block's content only at the epoch boundary, so nothing flickers mid-request). Details live behind **Context routes** fetched read-only; the prompt carries digests + pointers.

## Considered Options

- **V2-sources only** — architecturally pure, invisible until the V2 migration completes.
- **Plugin-only** — ships now, re-implements freshness by hand on a path V2 replaces.
- **Bigger static prompt** — the current shape; the drift class the fleet incident already documented (staged-skill drift breaking server-armed flows) is its steady state.

## Consequences

- Adding context to the prompt means adding a Block, not editing a template — the surface is auditable data.
- The skill index moves from baked-at-prep AGENTS.md text to a per-prompt Block: index drift becomes structurally impossible (the wave-1 composition that kills that incident class without waiting for the engine-side cache fix).
- Every block is bounded (≤10 lines) and provenance-stamped; agents cite block lines by stamp, and block generators are testable in isolation.
