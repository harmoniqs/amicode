---
name: develop
description: The develop mode in one skill — the director loop protocol bound to the dev gate pack (decompose → implement → integrate), session-ledger discipline, the implementer cast, the issue-DAG walk (branch/PR topology, parallel dispatch, merge strategy), cross-mode handoff seeds, and honest degradation on machines missing bundle parts or skill copies. Use when starting, running, or resuming a develop-mode issue-DAG campaign, or to AFK-implement issues from the board. (One skill per mode, mirroring `research`. This skill merges the former `autodev` mode-protocol skill — old references read-resolve here; the mode id's pre-rename alias is unchanged.)
agents: [implementer, orchestrator]
surface: public
source: amicode
revision: 3
---

# Develop — the director's protocol & issue-DAG walk

> **Install conventions** — this skill is the develop mode — protocol and issue-DAG walk
> together — engine- and install-neutral. Bindings for a given engine stay engine-side (the
> opencode binding of the director role is the `develop` primary agent card, and the
> engine-neutral loop core is the `director-core` skill — invoke it first at kickoff or
> resume; this file binds the mode's specifics to it). One skill per mode, mirroring
> `research`: the protocol sections are the mode's constitution, and the issue-DAG walk is
> the mode's primary workflow.

**Entry points:** the `develop` agent card (Tab-switch into dev mode — its prompt embeds
the director spine), `/develop <issue> [<issue> …]` from the top-level session, direct
invocation of this skill, or the standing line in the user's develop-mode kickoff prompts.
All four lead here; this file is the protocol.

**Announce at start:** "I'm using the develop skill to implement #\<n\> … via Amico."

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
   worktree directory path, `opencode/<slug>` branch name, expected artifacts)
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

The mode's phase graph is the **dev gate pack** (`modes/develop/pack.toml` in
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
   merge before that approval. The integrate phase also runs the skill-integrity
   hooks (skills lint when available on the branch; API-surface diff-check
   against the skill library — findings to `amicode/skills-integrity/`).
7. **Record.** Commit the ledger update: verdict-table row, loop-log row, §3
   state, next queue. Close every advisory (fixed / waived-with-reason /
   obsolete) and record closures. The update also carries the campaign's
   **skill delta** — findings filed, skills touched, proposals pending.
   Rewrite the session todo list to mirror §3 and §5 — the derived-view rule
   in `director-core`: current loop only; a stale todo list is a lying §3.
8. **Repeat.** Compact only at a boundary, and only when the user is present
   to choose it — the protocol does not otherwise try to time compaction (see
   below).

## The issue-DAG walk

<TOP-SESSION-ONLY>
The issue-DAG walk runs **only in the top-level session** — never wrap the walk in a dispatched subagent. The engine hard-blocks subagent-of-subagent: a dispatched subagent is given no dispatch tool of its own and no setting can grant one. The walk's entire job is to dispatch a per-slice Engineer per frontier; if the walk is itself a dispatched agent, every Engineer dispatch is depth-2 (subagent-of-subagent) and refused, so the walk cannot run a single slice. See the [Top-session-only invariant](#top-session-only-invariant); the walk's step 1 preflights it.
</TOP-SESSION-ONLY>

### Overview

Run one or more GitHub issues to completion. Each issue you pass is a **deliverable unit**: a parent expands into its sub-issues (the slices), a lone issue is a unit of one. Build the dependency DAG from GitHub `Blocked by` + `Part of` edges and walk it frontier-by-frontier, dispatching a per-slice Engineer per slice — in parallel where the DAG allows, via git worktrees.

This is the orchestration layer above the `/implement-issue` leaf: the walk schedules and integrates; the leaf implements one slice via `tdd`. The loop above is the protocol the walk runs inside; this section is the walk's own mechanics.

### Usage

```
/develop <issue> [<issue> …]
```

Examples:

- `/develop 42` — implement issue #42 (and its sub-issues, if any)
- `/develop 42 57 60` — implement three units in one run (one PR each)
- `/develop https://github.com/owner/repo/issues/42` — by URL
- `/develop` (no argument) — list candidate issues (open, on the board, unblocked) and ask the user to pick

### What the walk does

1. **Preflight — confirm this is the top-level session.** Before resolving anything, verify you are running in the **top-level session** and not a dispatched subagent (see [Top-session-only invariant](#top-session-only-invariant)). You are a subagent if your task was handed to you by a parent agent rather than invoked directly by the user, **or** if no dispatch tool is available to you. If either holds, **abort immediately** — resolve no issues and dispatch nothing — with:

   > `develop` aborted: the issue-DAG walk must run in the top-level session, but this session is a dispatched subagent. Its per-slice Engineer dispatches would be depth-2 (subagent-of-subagent), which the engine hard-blocks — the walk could not run a single slice. Re-run `/develop` from the top-level session.

   Run correctly (from the top-level session), this check passes silently and the walk proceeds unchanged.
2. Resolve each argument to an issue (number → the code-owning repo; URL as-is). Validate each issue exists and is open.
3. **Dispatch the walk.** Where an **orchestrator agent** is available, hand the walk to it — its definition documents this same loop: build the issue-DAG, schedule frontiers, dispatch the Engineer per slice, merge + integration-test each frontier, and checkpoint by closing sub-issues and moving board cards.
4. **Fallback — run the walk in-session, dispatching per slice where the engine allows.** Where no orchestrator agent is dispatchable in this environment, the top-level session runs the loop above itself: per frontier, cast each slice's implementer (the loop's step-4 cast, one TDD-ready slice per cast) and integrate per the merge strategy below. Say plainly which mode is running. Parallelism is lost only in the sequential sub-mode; correctness never is.

### Branch / PR topology

- **One integration branch + one PR per top-level argument** (`amico/issue-<n>-<slug>`), cut from the default branch. N issues → N PRs. Multi-issue input is an AFK throughput convenience, not a bundling instruction — coupling between units lives in the DAG (`Blocked by`), never on a shared branch.
- A unit's slices merge into its integration branch; the **parent draft PR** opens at the first frontier commit (`Closes #<parent>`, advancing the parent's board card to **In Progress**) and is marked ready when the unit's DAG completes green.
- **Cross-unit** `Blocked by` is honored globally: a unit blocked by another only starts once the blocker's code is on the default branch (its PR merged), then branches from the updated default — no stacking. A cross-unit-blocked parent sits in **Blocked** until then, clearing the same way (→ Ready on the blocker's merge, → In Progress at its first frontier commit).

### Parallel dispatch & shared worktrees

When a frontier has independent slices (non-overlapping `Touches:`/files, no `Blocked by` between them), dispatch them concurrently, capped by `AMICO_MAX_PARALLEL` (default 2; lower to 1 for Julia-heavy work). A slice that started in **Blocked** (an open `Blocked by` at creation) flips to **Ready** the instant its last blocker's PR merges — then to In Progress when actually dispatched (a parked-but-unblocked slice must not sit in stale Blocked). On dispatch, each slice's sub-issue card moves to **In Progress**; on its merge into the integration branch, closing the sub-issue lets the board's "Item closed" workflow move it to Done.

Worktrees are the isolation unit, created via `amicode_session` with `workspace: "create"` — **never** via direct `git worktree add`. Each worktree gets its `opencode/<slug>` branch. The checkout registry is the project-wide claim registry: re-read it before casting any implementer; claim the row; release it when work lands. First-writer-wins; races are possible and visible — a visible conflict beats a silent double-ownership every time.

### Merge strategy

The parent session merges worktree branches into the integration branch in **dependency-DAG order** — leaves before their dependents, never the reverse. The procedure after a frontier completes:

1. For each green branch in DAG-topological order, merge it into the integration branch.
2. **On merge conflict:** spawn a resolution session via `amicode_session` with `workspace: "<path>"` targeting the conflicting worktree. The resolution session rebases or resolves the conflict, commits, and returns.
3. **Unresolved conflicts** (resolution session fails or the conflict is structural): surface to the user with the conflicting files listed — never force-merge or silently drop changes.

### Worktree cleanup

Worktree removal after a successful merge is **best-effort**: the parent session attempts to remove the worktree directory after merging its branch. Residual worktrees (from crashes, interrupted sessions, or failed cleanups) are handled by the lifecycle tool `amicode_workspace` — never manually `rm -rf` a worktree directory or call `git worktree remove` directly.

### Role binding (engine-neutral)

The walk dispatches **the Engineer** — a role, not an engine feature. The role's contract: one TDD-ready slice per dispatch, caller-provided worktree branch, `implement-issue --orchestrated` semantics, no PR/merge/board writes (the walk owns lifecycle), a structured return, and an explicit `EXHAUSTED:` report if the agent hits its step limit — an open loop, never an outcome. Bindings, one per engine:

- **Claude Code** — the native orchestrator/engineer agents (the role definitions, engine-side).
- **opencode (Amicode)** — the `implementer` subagent card, staged with the Amicode project at `.opencode/agents/implementer.md`; same contract.

Engine-specific bindings stay engine-side; this skill names the role. A session with no binding for the Engineer runs the sequential sub-mode.

### Terminal state per unit

- **AFK** parent → the ready PR auto-merges (gated on CI where the repo has it); the parent issue closes on merge → the board's "Item closed" workflow moves its card to **Done** (never set manually).
- **HITL** parent → the ready PR requests review and stops (no merge) → set the parent's board card to **In Review** as the final step, then verify it held and re-set if the board's async "PR linked → In Progress" workflow clobbered it.

### When NOT to use

- To implement a **single** issue interactively/standalone → use `/implement-issue` directly (the walk is for autonomous, possibly multi-unit, DAG execution).
- To **design** an issue → use `brainstorming` → `write-an-issue` (the walk implements published issues, it does not design).

### Prerequisites

- **Invoked from the top-level session** — never from within a dispatched agent (the engine blocks subagent-of-subagent; see the [Top-session-only invariant](#top-session-only-invariant)). The preflight aborts fast on a subagent context.
- Each issue is TDD-ready (Acceptance Criteria as testable behaviors) — i.e. produced by `write-an-issue` / `break-into-subissues`.
- A parent's sub-issues are labelled `afk`/`hitl` (drives each slice's terminus; absent → HITL).
- The `gh` token has the `project` scope (for moving board cards) — without it, degrade silently per `write-an-issue`'s board rules.

## Roles at a glance

| Role | Subagent | Briefed with | Returns | Never |
|---|---|---|---|---|
| implementer | one TDD-ready slice, caller-provided worktree branch | the published issue (decision surface + AC), branch, artifact destinations | structured result: issue, status, branch, commit_shas, per-AC green flags | opens PRs; merges; touches the ledger; grades itself |

Enforcement honesty: the implementer's ledger-abstinence is discipline + git
history; the parent is the SOLE ledger writer and owns all lifecycle (PRs,
merges, board moves, issue closure) for orchestrated slices.

## Handoffs (cross-mode seeds)

The dev pack closes by handing a **hypothesis seed** to `research`
(`handoffs: hypothesis_seed → research`); this mode RECEIVES an **issue
seed** from `research`. The procedure, both directions:

- **Receiving (research → develop):** the seed is a typed note
  (`kind: issue`, `issue-seed` schema — title, motivation, evidence,
  suggested repo + tier). On the seed: re-read the ledger, render the seed
  through `write-an-issue` at its suggested tier (the evidence pointers become
  Prior Art), and run the loop above on the resulting issue.
- **Emitting (develop → research):** when a campaign closes with an open
  research question (a gate verdict that needs an experiment, a design
  question the issues surfaced), write the hypothesis-seed note (name the
  target posture, the question, the evidence), then hand it over — the
  receiving mode's protocol (the `research` skill) picks it up from there.
- **Switching modes mid-session is not yet specified; the mode cards'
  posture-honesty sections govern until it is.** The posture switcher (the
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
  (`modes/develop/` missing or incomplete), the phase/gate summary above is
  the only copy you have; name the gap, and record it for the doctor to
  surface.
- **Absent dispatch surface** — with no dispatchable implementer binding,
  the walk collapses to sequential in-session slices (the walk's fallback
  sub-mode); that is a degraded but correct mode, never a silent one.

## Compaction honesty

The agent cannot observe its own context usage, and auto-compact fires on a
token threshold with no phase awareness — it WILL fire mid-slice, unattended.
The protocol does not pretend to time it; it makes any compaction safe at any
moment: ledger current at every boundary including before every cast;
in-flight casts recorded with artifact destinations; implementer work
products are files in worktrees (a parent compaction cannot destroy an
in-flight slice, only the parent's own working notes); re-read + audit after
every compaction.

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

## Related skills

- **implement-issue** — the leaf this skill's walk dispatches per slice (`--orchestrated`).
- **write-an-issue** / **break-into-subissues** — produce the issues this skill consumes.
- **tdd** — the RED→GREEN loop the leaf runs inside each slice.
- **director-core** — the engine-neutral loop core both mode cards bind first.
