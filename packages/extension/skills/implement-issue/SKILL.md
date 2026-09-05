---
name: implement-issue
description: Implement one TDD-ready GitHub issue (a sub-issue, or an undecomposed parent that is its own slice) by driving it to green via the tdd skill, bracketed by branch / draft-PR / issue lifecycle. Use when picking a single ready issue off the board to implement. For a parent with open sub-issues, use develop instead.
agents: []
surface: public
source: amicode
revision: 1
---

# Implement an Issue

The **leaf executor** of issue-driven development. Take **one** TDD-ready slice and drive it to green by *calling* the `tdd` skill, bracketed by branch / draft-PR / issue lifecycle. This skill composes `tdd` — it never reimplements the RED→GREEN loop.

It is the development counterpart to the design pipeline (`brainstorming` → `write-an-issue` → `break-into-subissues`): that pipeline publishes TDD-ready issues; this skill picks one up and implements it.

**Announce at start:** "I'm using the implement-issue skill to implement #\<n\> via TDD."

## When to use / not use

- **One ready issue** — a sub-issue, an undecomposed parent, or a lone issue → use this skill.
- **A parent with open sub-issues** → use `develop` (it walks the sub-issue DAG, dispatching this skill per slice). This skill takes a **single** slice only; handed such a parent it stops and advises `develop` (see Step 2).
- **No resolved design yet** → STOP and use `brainstorming`. This skill implements a *published* issue; it does not design.

## Usage

```
/implement-issue <issue-number-or-url> [--branch <name>] [--base <branch>] [--orchestrated]
```

- `<issue>` — the single issue to implement (required).
- `--branch` / `--base` — branch override (see Step 3); rarely needed, the default is correct.
- `--orchestrated` — set by `develop` only; the slice runs on the caller-provided worktree branch (the branch already checked out). See Modes.

## Modes

| | **Standalone** (default) | **Orchestrated** (`--orchestrated`) |
|---|---|---|
| Invoked by | a human off the board, in the main session | `develop`, one slice per worktree |
| Branch | this skill creates it (Step 3) | use the caller-provided worktree branch; skip creation |
| PR | opens a draft PR, drives it to ready/merge | **opens no PR, performs no merge** |
| Terminus | AFK→merge / HITL→review (Step 6) | return the branch; `develop` merges + integration-tests |

Orchestrated mode is dispatched by `develop` (one slice per worktree, via the Engineer). It can also be invoked directly to exercise the seam.

---

## Procedure

### 1. Read the issue and its context

- `gh issue view <n> --json title,body,labels,number,url` (in the code-owning repo).
- Parse the body's `## Acceptance Criteria` (the RED list), `## Testing Decisions` (the reuse map, if present), `## Key Decisions`, `## Constraints & Invariants`, and `Prior Art`.
- If the body carries `Part of #N`, read the **parent** and load its **decision surface** (Problem / Approach / Constraints) as cross-cutting context — it is referenced by the sub-issue, not duplicated onto it.
- The issue carries no file paths or code by design; use `Prior Art` to find the modules to read, then read the **current** code.

### 1.5 Render the spec (standalone + interactive only)

Before checking eligibility, present the issue back to the user as the brief it was written to be — **never a raw body dump**:

- **Header** — `#<n> <title>`, the repo, the board status, and the `afk`/`hitl` signal.
- **Decision surface** — the `> [!IMPORTANT]` block reproduced as the skimmable card it is (Problem / Approach / Scope / Assumptions).
- **Acceptance Criteria** — as a checklist; these are the RED list, so the done-definition is visible up front.
- **Key Decisions / Constraints & Invariants** — tight bullets.
- **Prior Art** — the modules-to-read-first list.
- **Parent context** — when the body carries `Part of #N`, fold the parent's Problem/Approach into a line or two.

**Math renders as math.** When the issue carries mathematical content — objectives, Hamiltonians, bounds, error models — typeset it: inline LaTeX for symbols ($\hat H$, $\Omega_{\max}$, $F \geq 0.999$), display equations for objectives and derivations, and quantities exactly as the researcher writes them (infidelity as `2.1e-4`, tabular-nums where digits align). An issue in the physics vein gets elegant mathematical exposition, not prose-paraphrased formulas. Non-mathematical issues just get the clean card — no ceremony.

**Skip conditions:** `--orchestrated` mode (no human in the loop); non-interactive/AFK runs; **chore-tier** bodies (one line: number, title, problem — the record is already that short). This render is the same presentation `write-an-issue` uses at its approval gate — the approver and the implementer see the same brief.

### 2. Check eligibility

- **Parent guard:** if this issue has **open sub-issues**, it is not a single slice. Create nothing, comment advising `develop` (a sibling skill in the armed set — it walks the sub-issue DAG, dispatching this skill per slice), and return `blocked`.
- **Blocked-by gate:** read `Blocked by` from GitHub's native issue-dependency relationships via GraphQL — `gh api graphql` over `Issue.blockedBy(first:50){ nodes{ number state } }` (no native `gh` subcommand or `gh issue view --json` field exposes these; never read a body section). A blocker in `state: CLOSED` is satisfied. If any blocker is still open, create no branch, comment the unmet dependency on the issue, set its board card to **Blocked** (see `write-an-issue` step 7e), and return `blocked`. An explicit user "run anyway" is the only thing that overrides this gate.

### 3. Resolve the branch (override ladder)

Highest precedence wins:

1. **Explicit arg** — `--branch` / `--base` from the invocation.
2. **Repo convention** — a branch naming/base convention declared in the repo's `AGENTS.md` (or `CLAUDE.md`, whichever the repo carries).
3. **Default** — `gh issue develop <n>` (creates an issue-linked branch) cut from the current tip of `main`.

Branch from `main` (standalone) — blockers are merged first, so there is no stacking. An override may set the name/base/reuse-existing; it does **not** silently bypass the Blocked-by gate (Step 2).

**Orchestrated:** skip this step entirely — work on the caller-provided worktree branch.

### 4. Run the `tdd` loop

Invoke the **`tdd`** skill and let it run the RED→GREEN tracer-bullet loop. Supply:

- the issue's `## Acceptance Criteria` as the **RED list** — one tracer-bullet cycle per criterion;
- `## Testing Decisions` (when present) as the **reuse map** — which suites to extend (`reuse-first`). This is advisory: the modify-vs-create call stays in the `tdd` loop against the real suite.

**Planning gate:** `tdd`'s Planning step is an interactive human-approval gate. In a **non-interactive run** (AFK, or `--orchestrated`) it is **pre-satisfied by the published issue** — its Acceptance Criteria + Testing Decisions + the parent decision surface *are* the approved plan, ratified when the issue was published. Pass them to `tdd` in lieu of the interview and proceed. In an interactive standalone run you may still surface Planning to the user.

- **First commit → open the draft PR** (standalone, Step 5).
- Retries: a RED that won't go green is retried up to **2 cycles** before being declared stuck (Step 6). An Acceptance Criterion you cannot express as a test routes through that same stuck path — never silently skip it.
- **No test surface?** If the deliverable is prose (a skill, ADR, or config) or the repo has no executable suite, there is nothing to RED→GREEN — `tdd` degrades to **author-then-review against the Acceptance Criteria as a checklist**. "Done = green" then reads as "every AC satisfied by inspection," verified by walking representative scenarios. Single-artifact *code* (one script) still TDDs incrementally within this one issue.

### 5. Draft PR (standalone only)

- At the **first commit**, open a **draft** PR: `gh pr create --draft --title <…> --body <…>`. Link it to the invoked issue with `Closes #<invoked-issue>`. (Closing a sub-issue does **not** close its parent — parent closure is the orchestration layer's job.)
- On opening the draft PR, advance the issue's board card to **In Progress** (the standalone "work started" signal; see `write-an-issue` step 7e for the mechanism).
- The draft PR is the live surface: CI runs incrementally, RED-during-loop is expected, and on failure it becomes the WIP/escalation artifact (Step 6).
- Mark it ready (`gh pr ready`) **only** once the full suite is green.
- **Never** create the PR before the first commit (the branch itself is created in Step 3), and never in `--orchestrated` mode.

### 6. Terminal state

A slice is **done = green** (all its tests pass; demoable on its own). Status is `complete` **iff every** Acceptance Criterion is green; any non-green criterion → `failed`.

**Orchestrated:** skip the AFK/HITL terminus below — there is no PR, no merge, no push, and **no board-status change** (`develop` owns the card's In Progress / In Review / Done transitions for orchestrated slices). Once green, go to Step 7 and return the branch; `develop` merges, integration-tests, and decides the terminus. On failure, leave WIP committed on the branch and return `failed` (no PR, no comment-on-issue — `develop` owns escalation).

**Standalone** — read the AFK/HITL signal from the issue's `afk` / `hitl` label (**absent → treat as HITL**, the safe default).

**Standalone, green:**

| Tag | Action |
|---|---|
| **AFK** | mark PR ready → merge gated on CI: `gh pr merge --auto` where the repo has auto-merge enabled (merges *when* CI is green); where it doesn't (`--auto` is rejected), wait for CI to pass — or, in a repo with no CI, proceed directly — then plain `gh pr merge` → on merge, the issue closes (via `Closes`) and the board's **"Item closed" auto-workflow moves the card to Done** (never set Done manually). |
| **HITL** / untagged | mark PR ready → request review → set the board card to **In Review** as the *final* step, then re-read and re-set if the board's async "PR linked → In Progress" workflow clobbered it (see `write-an-issue` 7e) → **stop** (no merge). |

**AFK that cannot merge cleanly** (CI fails, or branch conflicts) → **downgrade to HITL**: do not merge, comment, leave the issue open.

**Failure** (the `tdd` loop stays RED after its 2 cycles, a `Key Decision` proves infeasible, an Acceptance Criterion is untestable, or a Blocked-by dep turns out unmerged):

- Stop. Push WIP to the (draft) PR.
- Comment the **precise** blocker on the issue (which criterion / decision / dependency, and why).
- Leave the issue open. Return `failed`.
- **Never** merge partial or non-green work. **Never** bounce into the design phase — escalate to a human (standalone) or to `develop` (orchestrated), which decide next.

### 7. Return

Return a structured result in all modes:

```yaml
issue: <number>            # the invoked issue's number
status: complete | blocked | failed
branch: <branch-name>
commit_shas: [<sha>, ...]
ac_results:
  - {criterion: "<text>", green: true|false}
notes: "<blocker / deviation / escalation detail>"
```

In `--orchestrated` mode `branch` is always set and **no PR exists** — `develop` consumes this to merge the branch, integration-test, and checkpoint (close the issue / move its card).

---

## Invariants

- Never merge partial or non-green work.
- Never auto-merge a HITL or untagged slice; auto-merge only an explicit `afk` slice, and only conditionally on CI.
- Never open a PR or merge in `--orchestrated` mode.
- Never create a branch or PR at issue-creation time; the draft PR is born at the first commit.
- Never reimplement the TDD loop inline — always call `tdd`.
- Inherit `tdd`'s test-protection rules: never delete, skip, or mark-broken tests to force green.
- `complete` only when **every** Acceptance Criterion is green — no "complete minus one".

## Source of truth

- **Status** of the work → the **org GitHub Projects board** (this skill moves the card).
- **Task content / canonical issue state** → the **issue** in the code-owning repo (`Closes #N` ties the PR to it).
- **The *why*** → the spec/ADR the issue's `## Source` references; this skill does not restate it.

## Composition

- Implements issues produced by `break-into-subissues` (slices) or `write-an-issue` (lone issues).
- Calls **`tdd`** for the RED→GREEN loop. Stack: `implement-issue` (read issue, bracket lifecycle) → `tdd` (loop, reuse-first, refactor).
- Dispatched per slice by **`develop`** (`--orchestrated`), which walks an issue-DAG; or used **standalone** on a single issue.

## Related skills

- **tdd** — the RED→GREEN loop this skill brackets.
- **write-an-issue** / **break-into-subissues** — produce the issues this skill consumes.
- **develop** — the orchestration layer above this leaf (walks a multi-issue DAG).
