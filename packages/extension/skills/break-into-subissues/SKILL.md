---
name: break-into-subissues
description: Break a published parent issue (a PRD / design-of-record) into independently-grabbable, TDD-ready sub-issues using vertical slices (tracer bullets), each rendered via write-an-issue at sub-issue granularity. Use after publishing a complex design to decompose it for autonomous implementation.
agents: []
surface: public
source: amicode
revision: 1
---

# Break Into Sub-Issues

Decompose a **published parent issue** (a PRD / design-of-record) into vertical-slice **sub-issues** detailed enough that an agent can implement each one autonomously via **TDD — no guessing**. Invoked by `brainstorming`'s terminus after the parent is published, or run directly on an existing parent issue.

Each sub-issue is rendered with **`write-an-issue`** at **sub-issue granularity**: cross-cutting context (Problem, Approaches Considered, architectural Risks) stays on the parent and is *referenced*, not duplicated; slice-local sections go on the sub-issue.

**Hierarchy, ordering, and dependencies are native GitHub relationships — not body text.** The parent ↔ sub-issue link is a real GitHub *sub-issue* edge (`addSubIssue`), slice order is the native sub-issue order (`reprioritizeSubIssue`), and a `Blocked by` dependency is a native *blocked-by* edge (`addBlockedBy`). This is the contract `develop` consumes: the Orchestrator builds its execution DAG from the GraphQL `parent`/`subIssues`/`blockedBy` fields, walking frontiers in dependency order. Body text (`Part of #<parent>`, a "Blocked by" line) is kept only as a human-readable *mirror* of those edges — never as the source of truth.

## Process

### 1. Locate the parent
The published parent issue (number / URL). If it's not in context, `gh issue view <number>` (with comments). Read its design-of-record.

### 2. Explore the codebase (if not already)
Understand the current state, so slices map to real seams and each sub-issue's Prior Art is accurate.

### 3. Draft vertical slices
Break the parent into **tracer-bullet** slices — each a thin but COMPLETE path through every layer (schema → logic → API/UI → tests), demoable/verifiable on its own. Prefer many thin slices over few thick ones.
- **Single-artifact deliverables don't slice.** If the work lands as one file — a skill `SKILL.md`, an ADR, a config, or a single script — keep it whole regardless of size: one file has no independently-mergeable paths, so "slices" would just serialize edits to it. Build it as one issue (TDD'd incrementally within the `tdd` loop when it's code). Decompose only when slices map to genuinely separable file/module seams.
- **AFK** (implement + merge with no human interaction) vs **HITL** (needs a human decision/review). Prefer AFK.
- Record `Blocked by` dependencies **and the intended slice order** — both become native edges in Step 6, so the breakdown plan must name them explicitly (slice B blocked by slice A; slices in execution order).

### 4. Approve the breakdown (gate)
Present the slice plan as a numbered list — **Title · Type (AFK/HITL) · Blocked by · which parent sections / user-stories it covers**. Ask: right granularity (too coarse / too fine)? right dependencies? merge or split any? Iterate until the user approves. **Create nothing on GitHub until approved.**

At this gate, also resolve **board status + assignee once for the whole set** — sub-issues normally all start in the same column (**Backlog** or **Ready**), with the native DAG (Step 6) controlling actual execution order. Read the live Status options and the repo's assignable users (see `write-an-issue` step 7a–b) and prompt once. Pass the chosen status/assignee down to each `write-an-issue` call in Step 5 so it **skips its per-issue prompt** — don't ask N times for N slices. (Use a per-slice column only if a slice genuinely belongs elsewhere.)

### 5. Render + create each sub-issue (TDD-ready)
In dependency order (blockers first, so you can reference real issue numbers), render each slice via **`write-an-issue`** at sub-issue granularity, then create it (`gh issue create`) and add it to the board with the **status/assignee resolved once at the Step 4 gate** (so `write-an-issue`'s board step runs without re-prompting). Creating in dependency-then-execution order matters: Step 6 attaches sub-issues in this same order, and native sub-issue ordering defaults to attach order — so a correct creation order gives correct slice ordering for free.

Each sub-issue MUST be **TDD-executable** — the implementer writes the failing test first, implements, and passes:
- **Acceptance Criteria** — each a *testable behavior*, phrased so a failing test can be written for it directly.
- **Testing Decisions** — the tests to write (external behavior, not internals). **Extend/modify** the named existing or prior-slice tests where they cover the behavior (`reuse-first`); create new only for genuinely new surface. When the slice builds on a prior slice, **flag the cross-slice edge** — *"extends #A's test surface"* — but leave the local modify-vs-create call to the implementer (the test is external behavior, not internals). This *is* the TDD spec.
- **Key Decisions** (+ data contracts) and **Constraints & Invariants** — slice-local, decision-complete, **no file paths/code** (the dev reads current code).
- **Source** — `Part of #<parent>` + the durable-record link, and a `Blocked by #<n>` line for each blocker. Reference the parent's cross-cutting sections; don't duplicate them. These lines are the human-readable mirror of the native edges wired in Step 6 — keep them consistent with those edges.

**Label each sub-issue `afk` or `hitl`** per its Step 3 classification — apply on `gh issue create` (`--label afk` / `--label hitl`), creating the label in the repo first if absent. This is the execution signal `/implement-issue` reads to decide its terminus (AFK → implement + merge unattended; HITL → stop at a ready PR for review). An unlabelled slice is treated as HITL by the implementer, so label deliberately.

A completed slice is green (all its tests pass) and demoable on its own. The implementer is a human, or the `/implement-issue` + `tdd` path.

### 6. Wire the native relationships
Establish the **native GitHub sub-issue hierarchy, ordering, and dependencies** — these are what `develop`/the Orchestrator read to build the execution DAG (it reads `parent`/`subIssues`/`blockedBy` via GraphQL; *text* like `Part of #<parent>` is invisible to it). The manual "sub-issue checklist on the parent" is gone — the native sub-issue list renders its own tracker on the parent. Do NOT close or rewrite the parent.

All three relationships are GraphQL mutations keyed by **node ID** (not issue number). Resolve a number → node ID once per issue:

```bash
gh issue view <number> --json id --jq .id     # → e.g. I_kwDO...
```

Then, in dependency-then-execution order (the Step 5 creation order):

**a. Attach each sub-issue to the parent (hierarchy).** Native order defaults to attach order, so attaching in execution order sets the ordering too:

```bash
gh api graphql -f query='
  mutation($parent:ID!, $child:ID!) {
    addSubIssue(input:{issueId:$parent, subIssueId:$child}) { issue { number } }
  }' -f parent=<PARENT_ID> -f child=<CHILD_ID>
```

**b. Wire each `Blocked by` dependency.** For slice B blocked by slice A, on B's node:

```bash
gh api graphql -f query='
  mutation($blocked:ID!, $blocker:ID!) {
    addBlockedBy(input:{issueId:$blocked, blockingIssueId:$blocker}) { issue { number } }
  }' -f blocked=<B_ID> -f blocker=<A_ID>
```

**c. Fix ordering only if needed.** If a slice was created out of order, reposition it instead of recreating — place `$child` after `$after` (or use `beforeId`):

```bash
gh api graphql -f query='
  mutation($parent:ID!, $child:ID!, $after:ID!) {
    reprioritizeSubIssue(input:{issueId:$parent, subIssueId:$child, afterId:$after}) { issue { number } }
  }' -f parent=<PARENT_ID> -f child=<CHILD_ID> -f after=<AFTER_ID>
```

The GitHub MCP `sub_issue_write` tool is an equivalent path for **a** and **c** (it takes the database `sub_issue_id`, `method: add`/`reprioritize`), but has **no** dependency operation — `addBlockedBy` (step **b**) is GraphQL-only, so prefer the uniform `gh api graphql` path for all three. If a mutation errors with a feature-flag message, retry with `-H "GraphQL-Features: sub_issues"` (a/c) or `-H "GraphQL-Features: issue_dependencies"` (b).

**Verify** the wiring matches the plan — the same query the Orchestrator uses:

```bash
gh api graphql -f query='
  query($owner:String!, $repo:String!, $n:Int!) {
    repository(owner:$owner, name:$repo) { issue(number:$n) {
      subIssues(first:50){ nodes{ number title } }
    } }
  }' -f owner=<OWNER> -f repo=<REPO> -F n=<PARENT_NUMBER>
```

Confirm every sub-issue appears, in the intended order, and spot-check `blockedBy` on a dependent slice.

**Reflect blocked state on the board.** Once the `blockedBy` edges exist, set each sub-issue with **≥1 open blocker** to the **Blocked** column (see `write-an-issue` step 7e), overriding its Step-4 default — its blockers aren't merged, so it isn't pickable yet. Leave slices with no open blocker in their resolved-once column. This is the initial mirror only; `develop` clears it as blockers merge (Blocked → Ready, then → In Progress on dispatch).

## Composition

- Invoked by `brainstorming`'s terminus **after** the parent design-of-record is published, when the work is large enough to need multiple vertical slices. A single small issue needs no decomposition.
- Calls **`write-an-issue`** once per slice — it owns the canonical design-of-record template; this skill owns *slicing* (tracer bullets, dependencies, TDD-readiness) and *wiring the native issue graph* (sub-issue hierarchy, ordering, blocked-by), not formatting.
- Produces the graph **`develop`** consumes: the Orchestrator's `develop` loop builds its DAG from the native `parent`/`subIssues`/`blockedBy` edges this skill writes in Step 6. Body-text references alone would leave that DAG empty.
