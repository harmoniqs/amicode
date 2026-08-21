# 0003 — The knowledge graph moves to a top panel as the agent's context tree; the vault gets a first-class surface

- Status: Accepted
- Date: 2026-07-27
- Deciders: Kate Bonner (Head of Product), on Aaron Trowbridge's design feedback (2026-07-26)
- Supersedes: ADR 0002 (Brain as chat background — direction parked)

## Context

The amico **Brain** rendered as an inline strip inside the message timeline: one row among
many, easy to scroll past, non-interactive by design (`aria-hidden` canvas, no hit-testing),
and drawn over a **hardcoded sample of the armonissima vault** rather than anything the
agent is actually doing. ADR 0002 proposed promoting it to a chat-wide living background;
that direction was reviewed and parked.

Aaron's feedback reframed what the graph is *for*: not ambience, but **orientation** — a
researcher watching the agent work wants to see *what the agent is holding in mind* and to
reach those artifacts directly. Two gaps followed from that framing:

1. The graph showed a decorative vault skeleton, not the session's real context, and
   nothing on it could be clicked.
2. The **vault itself** — the knowledge base the agent reads and writes — had no surface in
   the interface at all. The app could list mount names (`/amicode/vaults`) but could not
   browse or read a single note.

## Decision

**1. The graph moves out of the timeline into a pinned top panel** between the session
header and the chat, collapsible, one per session view. The inline brain strip row is
removed from the timeline (`TimelineRow.Brain` deleted); the ambient background direction
of ADR 0002 is not pursued.

**2. The graph is redesigned as the agent's context tree.** An organic, Obsidian-like
graph (layout updated from the initial tidy tree — Kate, 2026-07-27): root = amico pinned
at center; the session's turns orbit it (roman-numeral plates carrying the prompt
excerpt — the atlas idea, restructured); the distinct markdown, source, skills,
agents, and web references each turn pulled into context cluster around their turn
under a deterministic force settle. Commits only — searches/globs
are transient scouting and never enter the tree. A leaf re-touched by a later turn is
**deduplicated into a thin recall link** back to the existing node, so the tree stays a map
of distinct context, not a log. Marathon sessions fold their oldest turns into one
"earlier" branch.

**3. The tree is interactive — the graph is now a navigation instrument.** Nodes
hit-test; hover raises the label and hands the node to the host; **clicking a file node
opens the real file** — project files as a session file tab (the same flow as the file
tree), vault files in the Vault panel, landed directly on that note. Camera: auto-fit
until the user pans/zooms; wheel zooms about the cursor; double-click refits. The log's
hover-glance events (`amicode:brain-hover`) keep working against the tree.

**4. The vault lives in the interface.** A read-only **Vault panel** (drawer beside the
Chat, per the CONTEXT.md Panel concept) lists every attached mount and every file inside
it, and renders markdown and source inline. Two new raw server routes back it —
`GET /amicode/vault-files` (recursive listing) and `GET /amicode/vault-file` (single read,
real-path traversal guard, size cap) — beside the existing `/amicode/vaults` mount list.
Entry points: a titlebar vault button (both titlebar variants), the command palette
("Toggle vault panel"), and context-tree clicks on vault nodes.

## Consequences

- `brain-engine.ts` stays as-is (the ambient engine remains a library; the strip component
  is deleted). The context tree is a **separate, purpose-built engine**
  (`context-tree-engine.ts`): declarative `setTree`, deterministic force-settle layout,
  pointer interaction,
  DPR-change-aware canvas. Both engines remain exempt from the single-yellow accent rule as
  data visualizations; `#fff676` still marks only the live position.
- The tree derivation is pure and headless (`context-tree-data.ts`), unit-tested without
  the sync store; `brain-ref` now carries the full file path so nodes can open files.
- The vault routes are read-only and refuse path escapes even through symlinks; binaries
  are listed but marked unreadable, so the tree still shows the vault's true shape.
- Vault contents are proprietary knowledge, so browsing is a **local-researcher
  capability, not a server API**: the routes refuse on any non-loopback bind (same
  signal as the credential-mutation guard; `AMICO_VAULT_BROWSER=1` opts a shared
  deployment in, `=0` forces off, `=public` serves only public vaults — the
  hackathon-box mode). Per-mount browsability is **fail-closed by kind** (Aaron
  2026-07-27): personal and public browse by default; team/project/engagement —
  and unknown kinds — ship dark until their marker says `browse = true`;
  `browse = false` darkens any kind. The agent's read grants are unaffected.
- Keyboard reachability of individual canvas nodes is an open follow-up; every action the
  canvas offers also exists via keyboard-reachable surfaces (file tree, Vault panel).
