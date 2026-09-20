---
name: amico-strategy
description: Load and interpret the current Amico research direction. Use when planning experiments, checking direction, or deciding what to work on next.
agents: [researcher, librarian, dreamer]
surface: public
---

On-demand loader for the Amicode research **composition** (the D6 model, spec-20260905-103000): direction is PI-owned, the portfolio is derived, and this skill renders them — it never writes them.

## What exists (and what no longer does)

- **Direction** lives in `INTENT.md` (the amicissimo repo's vault dir), PI-owned: research bets, access filters, partner tracks, quality bars, banned directions, the campaign→direction map. It is amended **only by PR** — the human merge is the ownership transfer. `STRATEGY.md` in the team vault is **frozen evidence** of a retired ranked-P-list model; its superseded pointer is its only live content.
- **The portfolio** (what is actually being worked on) is **derived mechanically from campaign session-ledgers** — never the session DB, never the board. A campaign ledger is a `sessions/session-*.md` note in the personal vault.
- **The strategy brief** is the rendered composition: intent × portfolio, with **health stamps inline** (intent SHA + merged date + age; ledger anomalies; coverage) — staleness is IN the render.

## How to Load

Render the brief on demand:

```bash
amico-run strategy-brief --intent <path/to/INTENT.md> --sessions <path/to/sessions> [--as-of YYYY-MM-DD] [--out <path>]
```

Defaults resolve from the ops checkout and the personal vault. The render is deterministic (same inputs → same bytes) and **degrades with named unknowns** — an unparsable ledger is listed as an anomaly, never silently dropped; a missing receipt renders "unknown" stamps.

If the CLI is unavailable, read `INTENT.md` directly and fold the ledgers yourself, following the same discipline: one line per campaign (objective, state, last loop boundary, blockers), render order = the direction tiers joined through the campaign→direction map, unmapped campaigns after, grouped.

## How to Interpret

- **No ranked priority list exists or should be synthesized.** Direction tiers order the portfolio's render; they are not a to-do list. Priorities are what is actually being worked on — the derived portfolio plus PI judgment.
- **Health stamps are load-bearing:** an aged intent stamp or listed anomalies mean the render is stale or partial — say so before reasoning from it.
- **Before proposing a new experiment,** check the campaign→direction map and the portfolio: does an existing campaign cover this? Don't duplicate effort.
- **Direction changes are proposals, not edits:** intent-direction proposals go to the amicissimo proposals surface (one file per proposal); survey-derived suggestions go to the hopper with a triage tag. This skill exposes **no INTENT write verb** — there is no update path from an agent.

## Who Uses This

- **Research agents** — render the brief to produce the next experiment brief, anchored to a direction tier
- **Planning agents** — render the brief to plan campaigns against the actual portfolio
- **The weekly synthesis** — the scheduled pass calls the same renderer; on-demand renders and the weekly render are one renderer, two paths

## Updating Direction

It never happens from here. Humans amend INTENT by PR; the human merge is the ownership transfer. The retired model ("planning agents update STRATEGY.md") is dead — this skill is a loader, not a writer.
