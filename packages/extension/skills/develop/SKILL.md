---
name: develop
description: Autonomously implement a GitHub issue-DAG end-to-end — walks one or more issues (with their sub-issues) as a dependency graph, dispatching implement-issue per slice. Use when the user wants to AFK-implement issues from the board.
agents: [orchestrator]
surface: public
source: amicode
revision: 3
---

# Develop an Issue-DAG

<TOP-SESSION-ONLY>
The issue-DAG walk runs **only in the top-level session** — never wrap `/develop` (or the walk) in a dispatched subagent. The engine hard-blocks subagent-of-subagent: a dispatched subagent is given no dispatch tool of its own and no setting can grant one. The walk's entire job is to dispatch a per-slice Engineer per frontier; if the walk is itself a dispatched agent, every Engineer dispatch is depth-2 (subagent-of-subagent) and refused, so the walk cannot run a single slice. See the [Top-session-only invariant](#top-session-only-invariant); Step 1 preflights it.
</TOP-SESSION-ONLY>

## Overview

Run one or more GitHub issues to completion. Each issue you pass is a **deliverable unit**: a parent expands into its sub-issues (the slices), a lone issue is a unit of one. Build the dependency DAG from GitHub `Blocked by` + `Part of` edges and walk it frontier-by-frontier, dispatching a per-slice Engineer (which runs **`/implement-issue --orchestrated`**) per slice — in parallel where the DAG allows, via git worktrees.

This is the orchestration layer above the `/implement-issue` leaf: `develop` schedules and integrates; the leaf implements one slice via `tdd`.

**Mode binding:** this skill is the issue-DAG walk inside the **develop** mode (renamed from `autodev`; old ids read-resolve). The dev mode's *posture* binding — the loop protocol, the ledger discipline, the handoffs — is the **`autodev`** mode-protocol skill (its id keeps the pre-rename mode name; the workflow skill owns `develop`); defer to it for the mode, and to `director-core` for the shared spine.

**Announce at start:** "I'm using the develop skill to implement #\<n\> … via Amico."

## Usage

```
/develop <issue> [<issue> …]
```

Examples:

- `/develop 42` — implement issue #42 (and its sub-issues, if any)
- `/develop 42 57 60` — implement three units in one run (one PR each)
- `/develop https://github.com/owner/repo/issues/42` — by URL
- `/develop` (no argument) — list candidate issues (open, on the board, unblocked) and ask the user to pick

## What this skill does

1. **Preflight — confirm this is the top-level session.** Before resolving anything, verify you are running in the **top-level session** and not a dispatched subagent (see [Top-session-only invariant](#top-session-only-invariant)). You are a subagent if your task was handed to you by a parent agent rather than invoked directly by the user, **or** if no dispatch tool is available to you. If either holds, **abort immediately** — resolve no issues and dispatch nothing — with:

   > `develop` aborted: the issue-DAG walk must run in the top-level session, but this session is a dispatched subagent. Its per-slice Engineer dispatches would be depth-2 (subagent-of-subagent), which the engine hard-blocks — the walk could not run a single slice. Re-run `/develop` from the top-level session.

   Run correctly (from the top-level session), this check passes silently and the walk proceeds unchanged.
2. Resolve each argument to an issue (number → the code-owning repo; URL as-is).
3. Validate each issue exists and is open.
4. **Dispatch the walk.** Where the **orchestrator agent** is available, invoke `@orchestrator develop <issue> [<issue> …]`; it takes over — its definition documents the develop loop: build the issue-DAG (GraphQL `subIssues`/`parent`/`blockedBy`), schedule frontiers, dispatch the Engineer→`/implement-issue` per slice via `amicode_session` with `workspace: "create"` (each slice gets its own worktree and `opencode/<slug>` branch), merge + integration-test each frontier, and checkpoint by closing sub-issues and moving board cards.
5. **Fallback — run the walk in-session, dispatching per slice where the engine allows.** Where no orchestrator agent is dispatchable in this environment, the top-level session runs the same loop itself: per frontier, spawn each slice's implementer session via `amicode_session` with `workspace: "create"` — this creates an isolated worktree with an `opencode/<slug>` branch; **never call `git worktree add` directly** — then either
   - **dispatch each slice to the Engineer as a subagent** — where the session's agent registry provides one (see *Role binding* below), one dispatch per slice, capped by `AMICO_MAX_PARALLEL`, each executing the slice per `implement-issue --orchestrated` semantics in its worktree (Planning gate pre-satisfied by the published issue; **no per-slice PR**) and returning the step-7 structured result; or
   - **execute the slices sequentially itself** where no dispatchable agent exists, per the same `--orchestrated` semantics.

   In both modes the integration PR is opened here, the frontier's branches merge into it sequentially, sub-issues close and cards advance, then the walk continues. Every integrate boundary also runs the skill-integrity hooks: the skills lint (`node packages/extension/scripts/lint-skills.mjs`) when available on main, and a diff-check — where merged work changed a package API surface, grep the skill library for references to the changed symbols; hits become findings in `amicode/skills-integrity/` (personal vault). Every record boundary then carries a **skill delta** row: findings filed, skills touched, proposals pending. Say plainly which mode is running. Parallelism is lost only in the sequential sub-mode; correctness never is.

## Top-session-only invariant

**The issue-DAG walk runs only in the top-level session. Never wrap it in a dispatched agent.**

The walk exists to dispatch work: per frontier it dispatches a per-slice Engineer (each `isolation: "worktree"`, capped by `MAX_PARALLEL`) and then merges the returned branches — those Engineer dispatches are its entire mechanism. The engine blocks subagent-of-subagent **hard**: a dispatched subagent is given no dispatch tool, and there is no setting to grant one. So if the walk is itself running inside a dispatched agent, every Engineer dispatch it attempts is depth-2 (a subagent spawning a subagent) and is refused — the walk stalls before completing a single slice. A top-level session keeps those dispatches at depth-1, where the engine allows them.

That is why `/develop` must be invoked from the top-level session (interactive, or an AFK top-level run) and never from inside another agent's dispatch. Step 1 preflights this and aborts fast on a subagent context; run correctly from the top level there is no behavior change.

## Branch / PR topology

- **One integration branch + one PR per top-level argument** (`amico/issue-<n>-<slug>`), cut from `main`. N issues → N PRs. Multi-issue input is an AFK throughput convenience, not a bundling instruction — coupling between units lives in the DAG (`Blocked by`), never on a shared branch.
- A unit's slices merge into its integration branch; the **parent draft PR** opens at the first frontier commit (`Closes #<parent>`, advancing the parent's board card to **In Progress**) and is marked ready when the unit's DAG completes green.
- **Cross-unit** `Blocked by` is honored globally: a unit blocked by another only starts once the blocker's code is on `main` (its PR merged), then branches from the updated `main` — no stacking. A cross-unit-blocked parent sits in **Blocked** until then, clearing the same way (→ Ready on the blocker's merge, → In Progress at its first frontier commit).

## Parallel dispatch

When a frontier has independent slices (non-overlapping `Touches:`/files, no `Blocked by` between them), dispatch them concurrently via `amicode_session` with `workspace: "create"`, capped by `AMICO_MAX_PARALLEL` (default 2; lower to 1 for Julia-heavy work). In the in-session fallback this concurrency is bounded by subagent dispatch (Step 5); only where no dispatchable agent exists does it collapse to one-at-a-time. The worktree isolation is worth keeping in every mode. A slice that started in **Blocked** (an open `Blocked by` at creation) flips to **Ready** the instant its last blocker's PR merges — then to In Progress when actually dispatched (a parked-but-unblocked slice must not sit in stale Blocked). On dispatch, each slice's sub-issue card moves to **In Progress** (see `write-an-issue` step 7e); on its merge into the integration branch, closing the sub-issue lets the board's "Item closed" workflow move it to Done.

### Merge strategy

The parent `develop` session merges worktree branches into the integration branch in **dependency-DAG order** — leaves before their dependents, never the reverse. The procedure after a frontier completes:

1. For each green branch in DAG-topological order, merge it into the integration branch.
2. **On merge conflict:** spawn a resolution session via `amicode_session` with `workspace: "<path>"` targeting the conflicting worktree. The resolution session rebases or resolves the conflict, commits, and returns.
3. **Unresolved conflicts** (resolution session fails or the conflict is structural): surface to the user with the conflicting files listed — never force-merge or silently drop changes.

### Worktree cleanup

Worktree removal after a successful merge is **best-effort**: the parent session attempts to remove the worktree directory after merging its branch. Residual worktrees (from crashes, interrupted sessions, or failed cleanups) are handled by the lifecycle tool `amicode_workspace` — never manually `rm -rf` a worktree directory or call `git worktree remove` directly.

## Role binding (engine-neutral)

The walk dispatches **the Engineer** — a role, not an engine feature. The role's contract: one TDD-ready slice per dispatch, caller-provided worktree branch, `implement-issue --orchestrated` semantics, no PR/merge/board writes (the walk owns lifecycle), a structured step-7 return, and an explicit `EXHAUSTED:` report if the agent hits its step limit — an open loop, never an outcome. Bindings, one per engine:

- **Claude Code** — the native agent (the engineer role's definition, engine-side).
- **opencode (Amicode)** — the `implementer` subagent card, staged with the Amicode project at its dot-opencode/agents/implementer.md; same contract.

Engine-specific bindings stay engine-side; this skill names the role. A session with no binding for the Engineer runs the sequential sub-mode.

### Cast deaths (the empty return)

A cast that returns **empty** — state `completed`, zero output: no commits, no structured return — is a **cast death**, not an outcome. The empty return carries no information, including about the brief: verify from the worktree artifacts (commits, status, file mtimes), record the death in the ledger with that evidence, and recast the same brief. Three observed instances in one campaign all succeeded first-try on the recast — the brief was not the cause (finding F33).

## Terminal state per unit

- **AFK** parent → the ready PR auto-merges (gated on CI where the repo has it); the parent issue closes on merge → the board's "Item closed" workflow moves its card to **Done** (never set manually).
- **HITL** parent → the ready PR requests review and stops (no merge) → set the parent's board card to **In Review** as the final step, then verify it held and re-set if the board's async "PR linked → In Progress" workflow clobbered it (see `write-an-issue` 7e).

### Standing directives (AFK mandates)

A standing directive recorded in the ledger (the user's words + date — "do it all", "keep going for a while") is the explicit approval for the arc's issue filings AND its merge ladder, within the scope the directive names; every filing and every merge under it is reported in the loop record and the session summary. The mandate does not extend past its named scope: outward-publishing acts (releases, registration, visibility flips) always need the word. Worked example: the Favo campaign merged twelve standard-tier issues under two AFK mandates while holding its General-registry trigger parked for the user's explicit word (finding F34).

## When NOT to use

- To implement a **single** issue interactively/standalone → use `/implement-issue` directly (this skill is for autonomous, possibly multi-unit, DAG execution).
- To **design** an issue → use `brainstorming` → `write-an-issue` (`develop` implements published issues, it does not design).

## Prerequisites

- **Invoked from the top-level session** — never from within a dispatched agent (the engine blocks subagent-of-subagent; see the [Top-session-only invariant](#top-session-only-invariant)). Step 1 preflights this.
- Each issue is TDD-ready (Acceptance Criteria as testable behaviors) — i.e. produced by `write-an-issue` / `break-into-subissues`.
- A parent's sub-issues are labelled `afk`/`hitl` (drives each slice's terminus; absent → HITL).
- The `gh` token has the `project` scope (for moving board cards) — without it, degrade silently per `write-an-issue`'s board rules.

## Related skills

- **autodev** — the develop mode's protocol binding; this skill is the walk that runs inside it.
- **implement-issue** — the leaf this skill dispatches per slice (`--orchestrated`).
- **write-an-issue** / **break-into-subissues** — produce the issues this skill consumes.
- **tdd** — the RED→GREEN loop the leaf runs inside each slice.
