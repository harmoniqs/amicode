---
name: director-core
description: The canonical director-core protocol — the one loop every autonomous campaign runs (plan → dispatch through gates → analyze → record), the session-ledger discovery rule both mode cards quote verbatim, the four core clauses (ledger discipline, cast pattern, compaction honesty, anti-gaming), and the copilot/autoresearch/autodev posture model. Use when authoring or binding a mode card, a gate pack, or a campaign layer that consumes them.
agents: [orchestrator]
surface: internal
---

# Director core — the canonical loop protocol

One director, one loop, every campaign. This skill is the engine-neutral core
that mode cards bind; engine mechanics live in the cards, never here. It
extends the autoresearch protocol's spine — ledger discipline, cast pattern,
compaction honesty, anti-gaming — with the loop abstraction that makes that
spine mode-general. The autoresearch skill remains the research-mode
instantiation; this file is the shared spine both modes embed, not a copy of
either protocol.

## The loop, stated once

Any campaign is one loop: **plan → dispatch through gates → analyze → record.**

- **Plan** — pick the next unit of work from the campaign's queue and write
  its brief: a spec, an issue, a slice — whatever the mode's pack names.
- **Dispatch through gates** — cast the work to a role, then run the pack's
  gates over what comes back. The gates are a mode's entire personality.
- **Analyze** — ground the result in raw artifacts and derive what it
  changes: verdicts, ledger deltas, next seeds.
- **Record** — commit the ledger update; a loop's output is ledger state.

The differences between campaigns live entirely in the phase graph and the
gates — never in the loop, the memory, or the director.

**Gate packs.** A mode binds a gate pack **iff it is autonomous**. A gate pack
is typed data, not prose: `phases[]`, each phase carrying `gates[]` of
`{ name, kind: mechanical|human|derived, owner, procedure }`, plus `roles[]`;
one `closing_artifact`; and `handoffs[]`. Gates are named, owned, and
procedural so a campaign layer can consume the pack mechanically. The packs
themselves are committed fixtures; this core defines the shape and the
binding rule, not the packs.

## The ledger discovery rule (canonical block)

The fenced block below is the load-bearing export of this skill: mode cards
embed it verbatim inside their spine markers, so parity between the cards and
containment here make it the one ledger rule every mode resolves. It is
self-contained — quote it byte-identical or not at all.

```text
LEDGER DISCOVERY RULE v1

Path convention — the session ledger lives in the personal vault at
sessions/session-<YYYYMMDD>-<slug>.md: one ledger per campaign, created at
kickoff before any work.

Re-read-first discipline — the first action after any mode switch or any
compaction is to re-read the ledger from disk, never from memory, and to
audit any context summary against it. A mode switch re-binds the director's
posture only: the ledger itself is never rewritten by a switch, and the same
ledger serves every posture the campaign runs.
```

## Postures — one director, three postures

A **mode** is a posture of the one director, never a new session:

| Posture | Gate pack | Shape |
| --- | --- | --- |
| **copilot** — the zeroth | none (packless) | interactive: answers, designs, runs what the human asks — no autonomous loop, no campaign, no session ledger |
| **autoresearch** | the research pack | hypothesis queue → deliberate spec → experiment → gates → analyzer |
| **autodev** | the dev pack | issue DAG → TDD slices → CI/review → landed delta |

A mode switch re-binds the posture and re-reads the ledger (the discovery
rule above); the session ledger survives every switch. A mode may still
answer out-of-posture asks, then return to its loop.

## The four core clauses

### 1 — Ledger discipline

The ledger is the campaign's database: nine fixed sections, in order —

1. Objective & standing directives
2. The campaign's verdict table — hypotheses → verdict → evidence in
   research; issues/slices → status in dev
3. Active work: every in-flight item, including uncommitted file state and
   every in-flight cast (role, session id, spec or issue ref, expected
   artifacts)
4. Blocked & reasons
5. Next queue
6. Checkout topology (this campaign's rows in the checkout registry)
7. Gotchas & methodology
8. Loop log — append-only, one row per loop
9. Compaction log — append-only, one row per compaction

**Update triggers — all of them:** kickoff; every loop boundary; immediately
before casting any subagent; immediately before any manual compaction; at
pause or handoff. The director is the sole ledger writer.

### 2 — Cast pattern

Work is cast to subagents, one role per cast, roles drawn from the pack.
Roles that must not mutate state are read-only by permission, not by
promise; a role that writes is bounded to its assignment and never touches
the ledger. **Receipts are the currency of dispatch:** every cast lands a
recorded row — a receipt where an enforcing harness is present, a ledger row
carrying the same protocol-level fields where one is not. Briefs point at
files (ledger, notes, specs), never paste prose: a subagent with a fresh
context and a vague brief rediscovers everything the hard way.

### 3 — Compaction honesty

**The context window is a cache; the vault is the database.** Load-bearing
state lives in vault notes; the window holds only the working set. The
director cannot observe its own context usage, and auto-compaction fires
with no phase awareness — so the protocol does not try to time compaction;
it makes any compaction safe at any moment: the ledger is current before
every cast, with in-flight casts recorded alongside their artifact
destinations; subagent work products are files, so a parent compaction
cannot destroy in-flight work; and after every compaction, re-read the
ledger and audit the summary against it (the discovery rule).

### 4 — Anti-gaming

Verdicts are derived from commands, never self-reported: the director runs
the gates itself — test suites, verification commands — and no LLM,
including the director, judges a fidelity or CI claim; LLM judgment is
confined to drafting criteria and interpreting results, adversarially
reviewed. Raw artifacts are the evidence; prose is not. Promotion of any
result — to catalog, to status, to a merge of non-green work — is
human-only, always.

## What this core does not carry

Engine bindings (agent cards, dispatch mechanics, permission tooling) live
in the mode cards, engine-side. The research loop's specifics — the spec
gate's review budget, the checkout registry, the probe/experiment boundary —
stay with the autoresearch skill; the dev walk's — branch and draft-PR
lifecycle, worktree binding — stay with the develop and implement-issue
skills. This file carries only what every campaign shares: the loop, the
ledger, the cast, the clauses, the postures.
