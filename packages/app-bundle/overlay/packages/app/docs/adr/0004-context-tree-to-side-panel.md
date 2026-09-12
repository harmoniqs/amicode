# 0004 — Context tree relocates from the top panel to the context side panel

- Status: Accepted
- Date: 2026-08-08
- Deciders: Aaron Trowbridge (design), JJ Lee
- Supersedes: ADR 0003 (positioning clause only — interactivity, data model, vault browsability unchanged)

## Context

ADR 0003 moved the knowledge graph out of the message timeline into a pinned 192px top
panel between the session header and the chat. The intent was orientation: a researcher
watching the agent work sees what context it holds. In practice, the panel is persistent
visual noise — it consumes 192px of prime chat real estate on every session regardless of
whether anyone is looking at the graph. Aaron's recommendation (issue #264): remove it.

The session already owns a **context side panel** (opened from the progress-circle ring
button in the session header's top-right corner). That panel shows context-window stats,
a role-breakdown bar, the system prompt, and raw messages — all quantitative views of
"what's in the agent's context." The graph is the *qualitative/navigational* counterpart
and belongs with them.

## Decision

**The context tree canvas moves from the pinned top panel into the context side panel,
rendered at the top of that panel above the stats grid.** The top panel is removed; the
192px it occupied returns to the chat timeline.

Specifically:

1. The `ContextTreePanel` top-panel component is deleted from `message-timeline.tsx`.
2. The `ContextTreeFrame` rendering logic (canvas + keyboard nav + hover-glance listener)
   moves into `session-context-tab.tsx`, rendered as the first section.
3. The canvas keeps 192px height and fills the panel's width (the engine's `resize()` and
   auto-fit camera already adapt to container size).
4. No per-section collapse — the panel itself is the dismiss gesture (click the ring
   button again). The `localStorage` toggle (`amicode-context-tree-open`) is removed.
5. The `pause()`/`resume()` pattern keys on panel visibility instead of collapse state.
6. The `amicode:brain-hover` event listener moves with the canvas; when the panel is
   closed, it is a no-op (paused engine).
7. `sessionHasContextItems` remains in use — it gates whether the graph section renders
   inside the panel (no empty canvas on sessions with no committed context).

## Consequences

- `context-tree-engine.ts` and `context-tree-data.ts` are untouched — the engine is
  container-size-aware and needs no layout rework.
- 192px of vertical space returns to the chat on every session.
- The graph is on-demand: visible when the researcher explicitly opens the context panel,
  hidden otherwise.
- File-opening on node click continues to work identically (project files → session tab,
  vault files → Vault panel).
- The `CONTEXT.md` glossary entry for "Context tree" is updated to reflect the new
  location (inside the context side panel, no longer a "band folded into the session
  header").
