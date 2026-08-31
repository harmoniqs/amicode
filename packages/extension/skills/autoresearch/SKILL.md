---
name: autoresearch
description: The director's loop protocol for autonomous research sessions — session-ledger discipline, the hypothesizer/experimenter/analyzer trio, deliberate spec gates, checkout registry, and compaction-any-time safety. Use when starting, running, or resuming an autoresearch loop.
agents: [hypothesizer, experimenter, analyzer]
surface: public
vault_contract:
  folders: [sessions, experiments, specs]
  note_types: [session, experiment, spec, hypothesis]
  frontmatter: [session_id, status, tags]
project_contract:
  folders: [ledger/hypotheses, ledger/observations, ledger/campaigns, scripts, data, config]
---

# Autoresearch — the director's protocol

> **Install conventions** — this skill references *your personal vault* (the writable
> vault your Amicode studio mounts) for the session ledger, experiment notes, and specs,
> and your compute fleet where one exists. **When operating on a Research Project**
> (detected by `project.toml` in the workspace), use project paths instead of vault paths
> — see the path resolution table below. The protocol is engine- and install-neutral;
> bindings for a given engine stay engine-side (the opencode binding of the director role
> is the `autoresearch` primary agent card).

**Entry points:** the `autoresearch` primary agent (Tab-switch into research mode —
its prompt embeds this spine), direct invocation of this skill, or the standing line in
the user's autoresearch kickoff prompts. All three lead here; this file is the protocol.

The operating principle: **the context window is a cache; the vault is the database.**
Every piece of load-bearing state lives in a vault note; the context window holds only the
working set. Compaction (manual or auto) then costs nothing but a cache refill.

## Path resolution (project-aware)

When the system prompt includes an `## Active Research Project` block (injected by
`stack_state.ts` when a workspace folder has `project.toml`), use project paths.
When no project is bound, use vault paths. The checkout registry is always vault-based
(fleet-wide coordination).

| Artifact | Project-bound | Vault (no project) |
|----------|---------------|--------------------|
| Campaign ledger | `<project>/ledger/campaigns/campaign-<YYYYMMDD>-<slug>.md` | `<personal vault>/sessions/session-<YYYYMMDD>-<slug>.md` |
| Hypotheses | `<project>/ledger/hypotheses/` | `<vault>/hypotheses/` |
| Observations | `<project>/ledger/observations/` | `<vault>/experiments/` |
| Scripts | `<project>/scripts/` | (none — vault has no scripts) |
| Data | `<project>/data/` | (none) |
| Config | `<project>/config/` | (none) |
| Checkout registry | `<personal vault>/sessions/CHECKOUTS.md` | `<personal vault>/sessions/CHECKOUTS.md` |

## The session ledger (create at kickoff, before any work)

Path: `<personal vault>/sessions/session-<YYYYMMDD>-<slug>.md`. Nine sections, in order:

1. Objective & standing directives
2. Hypothesis ledger (H# → verdict → evidence → wiki-links)
3. Active work — every in-flight item, INCLUDING uncommitted per-file diff state AND every
   in-flight subagent cast (role, session id, spec id, assigned env, expected artifacts)
4. Blocked & reasons
5. Next queue
6. Checkout topology (mirror of this session's rows in `sessions/CHECKOUTS.md`)
7. Gotchas & methodology
8. Loop log (append-only, one row per loop: date, H#, spec_id, review verdict, plan hash,
   experimenter session id, gate verdicts, advisory closures)
9. Compaction log (append-only: timestamp, auto/manual, messages dropped, summary audit)

**Update triggers — all of them:** kickoff; every loop boundary; **immediately BEFORE
casting any experimenter** (record the cast — a compaction mid-flight must be able to learn
from the ledger what is in the air and where its artifacts will land); immediately before
any manual `/compact`; at pause/handoff.

**First action after ANY compaction: re-read the ledger from disk, then audit the summary
against it** — does the summary name the ledger path, carry the current H-verdict table,
reference the in-flight casts? Append the audit row to §9.

## The loop (one iteration)

1. **Re-read the ledger** — from disk, never from memory.
2. **Hypothesis queue thin?** Cast the **hypothesizer** (read-only subagent): ranked
   hypotheses + a spec-card draft. Parent picks the winner.
3. **Spec gate (deliberate):** file the spec card to `<personal vault>/specs/`, run
   `amico spec review <path>` — resolve blocking findings, re-run (round budget 3).
   `--allow-unreviewed` is FORBIDDEN for launch-shaped work (spends compute); if compile
   refuses for want of review, the fix is to review, never the flag.
4. **Ledger the cast, THEN cast the experimenter** (one experiment per spec, assigned env
   per `sessions/CHECKOUTS.md`; claim the checkout row first). Parallel experimenters only
   where the registry says files are disjoint.
5. **Run the gates yourself (parent, via bash):** test suites, `amico plan status` where a
   compiled plan exists. Verdicts are DERIVED, never self-reported. No LLM — including
   you — judges a fidelity claim; LLM judgment is confined to drafting criteria and
   interpreting results, adversarially reviewed, human-owned at promotion.
6. **Cast the analyzer** (read-only): raw-artifact-grounded insights, a proposed ledger
   delta, next-hypothesis seeds.
7. **Commit the ledger update** (sole writer): H-table row, loop-log row, §3 state, next
   queue. Close every advisory (fixed / waived-with-reason / obsolete) and record closures.
8. **Repeat.** Compact only at a boundary, and only when the user is present to choose it —
   the protocol does not otherwise try to time compaction (see below).

## Roles at a glance

| Role | Subagent | Briefed with | Returns | Never |
|---|---|---|---|---|
| hypothesizer | read-only (edit+bash denied) | objective, ledger path | ranked hypotheses + spec card | executes anything |
| experimenter | full access, one spec | reviewed spec, env assignment, note path | numbers-only debrief + own experiment note | touches ledger; grades itself |
| analyzer | read-only (edit+bash denied) | note + RAW artifact paths, gate verdicts | ledger-delta proposal + next seeds | writes; decides |

Enforcement honesty: the two read-only roles are permission-isolated; the experimenter's
ledger-abstinence is discipline + git history. The parent is the SOLE ledger writer.

## Deliberate integration — current tooling state (honest)

- `amico spec review` WORKS on this box: tier-1 mechanical lenses always; judgment critics
  when a critic binary is available — when the verdict is `approved-mechanical`, say so,
  and weigh a manual critic round (independent read-only subagents, one lens each:
  consistency / ops failure modes / trust & anti-gaming) for anything load-bearing.
- `amico plan compile` currently FAILS on this box (no `$AMICO_CRITIC_BIN` / agent CLI).
  Degraded path until it lands: the reviewed spec + parent-tracked steps in the ledger's
  loop log stand in for the compiled plan; gate verdicts still come from real commands
  (test suites, verification scripts), never from the experimenter's say-so.
- **Probe/experiment boundary (mechanical):** read-only ops and bounded side-effect-free
  one-liners (< ~1 min, writes nothing durable, no solve, no test suite) are probes — no
  spec. Writes a durable file, launches a solve, or runs a test suite → experiment → spec.
  Audit rule: a probe whose result is cited in the loop log as experiment evidence was
  misclassified — record the misclassification when caught.

## Compaction honesty

The agent cannot observe its own context usage, and auto-compact fires on a token threshold
with no phase awareness — it WILL fire mid-experiment, unattended. The protocol does not
pretend to time it; it makes any compaction safe at any moment: ledger current at every
boundary including before every cast; in-flight casts recorded with artifact destinations;
experimenter work products are files (a parent compaction cannot destroy an in-flight
experiment, only the parent's own working notes); re-read + audit after every compaction.

## Parallel sessions & shared checkouts

`sessions/CHECKOUTS.md` is the fleet-wide claim registry. Re-read it before casting any
experimenter; claim your row; release it when work lands. First-writer-wins, propagated by
the ~15-min sync; races inside the window are possible and visible — a visible conflict
beats a silent double-ownership every time.

## Standing anti-gaming contract

Production `step` paths only for A/B loop experiments; CRN pairing with f=0-style
invariants; impossibility checks on noise denominators; FD sanity gates on derived
quantities; raw artifacts are the evidence, prose is not. Promotion of any result to
catalog/status is human-only, always.

## Failure modes to watch

- **The thin brief** — a subagent with a fresh context and a vague brief rediscovers
  everything the hard way. Briefs point at files (ledger, notes, specs), never paste prose.
- **The stale ledger** — if §3's uncommitted state is older than the last edit on disk, the
  ledger is lying; refresh it before acting on it.
- **EXHAUSTED debriefs** — an experimenter that hit its step cap reports `EXHAUSTED:`;
  that's an open loop in §5, never an outcome in §2.
- **Summary drift** — after each compaction, the audit in §9 is the check that the summary
  still points HERE rather than becoming a competing source of truth.
