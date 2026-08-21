# Agentic surfaces — static elements generated from the researcher's work state

- Status: Proposal for discussion (Kate × Aaron) — no implementation yet
- Date: 2026-07-27
- Origin: Aaron Trowbridge's feedback (2026-07-26): "the potential to make static
  elements agentically generated based on the user's current work state"

## The idea

Most of the interface outside the conversation is **authored once and shown to
everyone**: the new-session view, the setup nudge, empty states, panel headers, the
defaults capsule. Aaron's observation is that an agent product doesn't have to treat
these as fixed copy — the agent knows the researcher's work state (active problems, run
history, vault recency, calibration drift, what the last session ended on) and could
**compose these surfaces** the way it composes an answer.

The context-tree top panel (ADR 0003) is the first surface of this kind already shipped:
its content is entirely derived from work state, with a fixed *frame* and generated
*content*. This document asks where else that pattern pays for itself.

## Inventory — static elements that could be work-state-driven

| Surface | Today | Agentically generated would mean |
|---|---|---|
| New-session view | Fixed problem list + copy | "You were mid-sweep on the CZ ladder; run 9 finished overnight — resume?" with the 2–3 next actions ranked from ledger + session history |
| Setup nudge | Profile completeness flag | Nudge text chosen from the actual missing step (vault, Julia, connection) and phrased against what the user tried last |
| Empty states (run gallery, pulse bank, library) | Generic copy | Seeded with the nearest real thing: last run, closest catalog pulse, most-recent paper |
| Session header context | Session title | One generated line of "where this thread left off" on resume |
| Composer placeholder | Fixed prompt copy | Rotates against work state ("ask about run 12's stagnation…") |
| Defaults capsule | Static solver defaults | Defaults proposed from the last N solves of this problem family |

## Architecture sketch — three tiers, in order of trust

1. **Derived (no LLM, deterministic).** Templates filled from ledger/vault/session
   queries. Cheap, always fresh, testable — the context tree lives here. Most of the
   table above can too, and this tier should be exhausted first.
2. **Generated-and-cached.** A background agent (the distiller cadence fits) writes
   short surface copy into a per-user store; the UI renders it as data. Latency-free at
   render time; staleness bounded by the cadence. The existing server-rendered widget
   pipeline (`widgets-src/*` → `/amicode/widget-frame`) is the natural substrate — it
   already solves sandboxing, CSP, and per-widget data plumbing.
3. **Live-generated.** Composed at render time by a model call. Highest freshness,
   highest cost, needs skeleton states and a hard timeout fallback to tier-1 content.
   Probably justified only for the new-session view, if at all.

## Constraints that must hold

- **Frames are fixed; content is generated.** Layout, tokens, and interaction patterns
  stay authored (amicode-design-system governs them); the agent fills slots. No
  agent-invented UI structure.
- **Fallback is the current static copy.** Every agentic surface degrades to exactly
  what ships today — an empty work state must never produce a broken or blank surface.
- **Provenance visible on anything actionable.** If a surface proposes an action
  ("resume the sweep"), it must say what it derived that from, and be wrong-safe:
  clicking a stale suggestion can never destroy state.
- **No surprise tokens.** Tier 2/3 generation runs on explicit cadences or user action,
  never silently per-render.

## Open questions for Aaron

1. Which surface first? The new-session view has the highest leverage (it's the landing
   for every returning user), but empty states are the cheapest proof of the pattern.
2. Is tier 2 (cached generation on the distiller cadence) fresh enough, or does the
   resume-context line need tier 3?
3. Should generated copy be visibly marked (e.g. the thought-color accent) so
   researchers learn which parts of the interface are alive?
4. Does the widget kernel become the delivery mechanism for all of this, or is it
   simpler to add a `GET /amicode/surface?id=…` route returning structured slots?

## Relationship to shipped work

- **Context tree (ADR 0003)** — tier 1, shipped. The template for "fixed frame,
  work-state content."
- **Command zoom fixes** — unrelated mechanically, but they remove the "static chrome is
  broken" noise that would undermine trust in smarter chrome.
- **Vault panel** — the read path any generated surface will cite when it references
  vault knowledge.
