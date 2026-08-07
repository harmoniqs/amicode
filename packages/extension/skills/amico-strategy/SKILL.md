---
name: amico-strategy
description: Load and interpret the current Amico research strategy. Use when planning experiments, checking priorities, or deciding what to work on next.
agents: [researcher, librarian, dreamer]
surface: public
---

On-demand loader for the Amico research strategy. This skill tells you how to read and interpret `STRATEGY.md`.

## How to Load

Read `STRATEGY.md` from the **team vault** — the `kind=team` mount (`<team-vault>/STRATEGY.md`). If no team vault is mounted, this skill is inert — there is no strategy to load.

## Structure

`STRATEGY.md` contains:

1. **Active Priorities (P1-P11+)** — ranked research goals with platform, gate, target fidelity, and status
2. **Backlog (B1-B13+)** — future work items not yet prioritized
3. **Constraints** — blocking dependencies (e.g., "P1 blocked on Intonato Phase 4")
4. **Device assignments** — which devices are allocated to which priorities

## How to Interpret

- **P1 is always top priority.** When choosing what to work on, start from P1 and work down.
- **Status field matters:** `active` means work is ongoing; `completed` means it's done; `blocked` means a dependency must be resolved first.
- **Before proposing a new experiment,** check if the target (platform + gate) already has an active priority. Don't duplicate effort.
- **Backlog items** can be promoted to active priorities when capacity opens up or blocking dependencies resolve.

## Who Uses This

- **Research agents** — read strategy to produce the next experiment brief
- **Planning agents** — read strategy to plan multi-experiment campaigns
- **Humans** — when deciding what to work on or reviewing the roadmap

## Updating Strategy

`STRATEGY.md` is updated by humans and by planning agents after significant results (new fidelity records, completed priorities, new blocking dependencies). Always read the latest version before acting on it.
