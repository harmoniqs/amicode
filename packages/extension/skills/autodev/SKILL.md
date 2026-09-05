---
name: autodev
description: The director's loop protocol for autonomous development sessions — the dev gate pack's phases and gates (decompose → implement → integrate), the implementer cast, session-ledger discipline, cross-mode handoff seeds, and honest degradation on machines missing bundle parts or skill copies. Use when starting, running, or resuming an autodev issue-DAG campaign.
agents: [implementer]
surface: public
source: amicode
revision: 1
---

# Autodev — the director's protocol

> **Install conventions** — this skill is the dev mode's protocol, engine- and
> install-neutral; bindings for a given engine stay engine-side (the opencode
> binding of the director role is the `autodev` primary agent card, and the
> engine-neutral loop core is the `director-core` skill — invoke it first at
> kickoff or resume; this file binds the mode's specifics to it).

**Entry points:** the `autodev` agent card (Tab-switch into dev mode — its
prompt embeds the director spine), direct invocation of this skill, or the
standing line in the user's autodev kickoff prompts. All three lead here; this
file is the protocol.

The operating principle: **the context window is a cache; the session ledger is
the database.** Every piece of load-bearing state lives in the campaign ledger
— objectives, the issue/slice verdict table, in-flight casts, blocked reasons,
the loop log. The context window holds only the working set. Compaction (manual
or auto) then costs nothing but a cache refill.

## The ledger (create at kickoff, before any work)

Path convention: the session ledger lives in the personal vault at
`sessions/session-<YYYYMMDD>-<slug>.md` — one ledger per campaign, created at
kickoff before any work. The canonical ledger discovery rule — re-read-first
after any mode switch or compaction, a switch re-binds the posture and never
rewrites the ledger — is the generated region the mode cards carry verbatim;
the `director-core` skill owns the canonical block.

Nine sections, in order:

1. Objective & standing directives
2. Verdict table — issues/slices → status → evidence (gate verdicts, PR links)
3. Active work — every in-flight item, INCLUDING uncommitted per-file diff
   state AND every in-flight implementer cast (role, session id, issue ref,
   worktree branch, expected artifacts)
4. Blocked & reasons
5. Next queue
6. Checkout topology (the campaign's worktree rows in the checkout registry)
7. Gotchas & methodology
8. Loop log (append-only, one row per loop: date, issue/slice, gate verdicts,
   implementer session id, review outcome, advisories closed)
9. Compaction log (append-only: timestamp, auto/manual, messages dropped,
   summary audit)

**Update triggers — all of them:** kickoff; every loop boundary; **immediately
BEFORE casting any implementer** (record the cast — a compaction mid-flight
must be able to learn from the ledger what is in the air and where its
artifacts will land); immediately before any manual `/compact`; at
pause/handoff.

**First action after ANY compaction: re-read the ledger from disk, then audit
the summary against it** — does the summary name the ledger path, carry the
current verdict table, reference the in-flight casts? Append the audit row to §9.

## The loop (one iteration) — bound to the dev gate pack

The mode's phase graph is the **dev gate pack** (`modes/autodev/pack.toml` in
the amicode repo, schema'd data): phases **decompose → implement → integrate**,
one gate set per phase. One loop:

1. **Re-read the ledger** — from disk, never from memory.
2. **Plan/decompose.** Pick the next unit from the queue. New work attaches to
   an issue and a PR **before any file is modified** (**dev-gate**, mechanical,
   director-owned): parents decompose via `break-into-subissues` into TDD-ready
   slices rendered by `write-an-issue`; the branch-and-PR topology is
   established before the first slice dispatches.
3. **Blocked-by clearance** (**blocked-by-clearance**, mechanical): read each
   slice's native blocked-by dependencies before creating any branch; a slice
   with an open blocker is never started and sits blocked until the blocker's
   PR merges.
4. **Ledger the cast, THEN cast the implementer** (the pack's implement phase,
   one role): one TDD-ready slice per cast, on a caller-provided worktree
   branch, `implement-issue --orchestrated` semantics — no PR, no merge, no
   board writes from the cast; the structured return is the receipt
   (**tdd-red-green**, mechanical, implementer-owned: drive each acceptance
   criterion red→green; never delete, skip, or mark a test broken to force
   green; a red that will not go green is a `failed` return, never a
   negotiation).
5. **Run the gates yourself (parent, via bash)** (**draft-pr-lifecycle**,
   derived: the draft PR opens at the first commit, is marked ready only when
   the full suite is green, and green branches merge sequentially — never
   partial or non-green work). Verdicts are DERIVED from commands, never
   self-reported; no LLM — including you — judges a CI or green-suite claim.
6. **Integrate + checkpoint** (the pack's integrate phase): merge the
   frontier's green branches into the integration branch, close sub-issues,
   advance board cards; **review** (human-owned) gates any unit finishing under
   HITL — a ready PR approved by a reviewer who is never the implementer, no
   merge before that approval.
7. **Record.** Commit the ledger update: verdict-table row, loop-log row, §3
   state, next queue. Close every advisory (fixed / waived-with-reason /
   obsolete) and record closures.
8. **Repeat.** Compact only at a boundary, and only when the user is present
   to choose it — the protocol does not otherwise try to time compaction (see
   below).

## Roles at a glance

| Role | Subagent | Briefed with | Returns | Never |
|---|---|---|---|---|
| implementer | one TDD-ready slice, caller-provided worktree branch | the published issue (decision surface + AC), branch, artifact destinations | structured result: issue, status, branch, commit_shas, per-AC green flags | opens PRs; merges; touches the ledger; grades itself |

Enforcement honesty: the implementer's ledger-abstinence is discipline + git
history; the parent is the SOLE ledger writer and owns all lifecycle (PRs,
merges, board moves, issue closure) for orchestrated slices.

## Handoffs (cross-mode seeds)

The dev pack closes by handing a **hypothesis seed** to `autoresearch`
(`handoffs: hypothesis_seed → autoresearch`); this mode RECEIVES an **issue
seed** from `autoresearch`. The procedure, both directions:

- **Receiving (autoresearch → autodev):** the seed is a typed note
  (`kind: issue`, `issue-seed` schema — title, motivation, evidence,
  suggested repo + tier). On the seed: re-read the ledger, render the seed
  through `write-an-issue` at its suggested tier (the evidence pointers become
  Prior Art), and run the loop above on the resulting issue.
- **Emitting (autodev → autoresearch):** when a campaign closes with an open
  research question (a gate verdict that needs an experiment, a design
  question the issues surfaced), write the hypothesis-seed note (name the
  target posture, the question, the evidence), then hand it over — the
  receiving mode's protocol (the `autoresearch` skill) picks it up from there.
- **Switching modes mid-session: PENDING-D5.** The posture switcher (the
  titlebar's mid-session agent switch) is not landed on every install yet —
  until the fork's posture surfaces ship, the safe path is to **spawn or open
  the target posture's session on the seed** rather than switching in place;
  the ledger discovery rule holds either way (a switch re-binds the posture,
  the ledger survives). Seed-write failures are reported in-chat — never
  silently dropped.

## Honest degradation (what is missing on THIS machine)

The dev mode binds several artifacts; a machine may lack some of them. Say
plainly what is missing, and degrade honestly — never pretend a missing piece
is present:

- **Absent skill copies** — if the skill index does not list
  `director-core`, `develop`, `implement-issue`, `write-an-issue`, or
  `break-into-subissues`, the staged library is missing its dev-workflow
  skills (the shipped copies did not stage). Zero dev skills staged means the
  walk degrades: run the loop from this file + the card's spine, say so, and
  note the gap in the ledger — do not fabricate the skills' procedures from
  memory when a step references one that is absent.
- **Absent bundle parts** — if the mode card or the gate pack did not stage
  (`modes/autodev/` missing or incomplete), the phase/gate summary above is
  the only copy you have; name the gap, and record it for the doctor to
  surface.
- **Absent dispatch surface** — with no dispatchable implementer binding,
  the walk collapses to sequential in-session slices (the `develop` skill's
  fallback); that is a degraded but correct mode, never a silent one.

## Compaction honesty

The agent cannot observe its own context usage, and auto-compact fires on a
token threshold with no phase awareness — it WILL fire mid-slice, unattended.
The protocol does not pretend to time it; it makes any compaction safe at any
moment: ledger current at every boundary including before every cast;
in-flight casts recorded with artifact destinations; implementer work
products are files in worktrees (a parent compaction cannot destroy an
in-flight slice, only the parent's own working notes); re-read + audit after
every compaction.

## Parallel sessions & shared checkouts

Worktrees are the isolation unit; the checkout registry is the project-wide
claim registry. Re-read it before casting any implementer; claim the row;
release it when work lands. First-writer-wins; races are possible and
visible — a visible conflict beats a silent double-ownership every time.

## Standing anti-gaming contract

Verdicts derive from commands and CI, never from prose or self-report;
**done = green** means every acceptance criterion green, no "complete minus
one"; never merge partial or non-green work; the reviewer is never the
implementer; promotion of any result — merge, release, board Done — is
human-only where the label says HITL, always. Raw artifacts are the evidence.

## Failure modes to watch

- **The thin brief** — an implementer with a fresh context and a vague brief
  rediscovers everything the hard way. Briefs point at files (the issue, the
  ledger, the pack), never paste prose.
- **The stale ledger** — if §3's uncommitted state is older than the last
  edit on disk, the ledger is lying; refresh it before acting on it.
- **EXHAUSTED returns** — an implementer that hit its step cap reports
  `EXHAUSTED:`; that's an open loop in §5, never an outcome in §2.
- **Summary drift** — after each compaction, the audit in §9 is the check that
  the summary still points HERE rather than becoming a competing source of
  truth.
