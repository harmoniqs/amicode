---
name: write-an-issue
description: Render and create the canonical design-of-record GitHub issue — the two-reader decision-surface template, density tiers (chore / standard / PRD), scratchpad drafting, labels, and Projects board placement. Use whenever any issue is created — from brainstorming's terminus, once per break-into-subissues slice, or from the development gate's chore-tier auto-create.
agents: []
surface: public
source: amicode
revision: 1
---

# Write an Issue

Owns the **canonical GitHub issue**: the two-reader decision-surface template, the density tiers, the scratchpad drafting convention, label management, and Projects board placement. Every issue-creation path funnels here — `brainstorming`'s terminus (design-of-record), `break-into-subissues` (TDD-ready slices), and the **development gate** (chore-tier auto-create when package work starts without an issue).

This skill owns *format and creation*, not content: `brainstorming` owns the design, `break-into-subissues` owns slicing, the gate owns the trigger. The body this skill writes is what `implement-issue` parses on pickup — the section names below are a contract; do not drift them.

## The template (two-reader decision-surface layout)

A `> [!IMPORTANT]` decision surface for the reader who only needs the *why*, over execution detail for the reader who implements. Rules across all tiers: **no file paths, no code** (the implementer reads current code; Prior Art points at modules), decision-complete, testable criteria, **include-if-present** (a section with no content is omitted, never left as an empty heading).

```markdown
> [!IMPORTANT]
> **Problem** — <what's broken / wanted, and why it matters>
> **Approach** — <the chosen direction, one paragraph>
> **Approaches considered** — <alternatives + why rejected>          (PRD tier)
> **Scope** — in: <…> · out: <…>
> **Assumptions** — <what we're taking as true>

## Acceptance Criteria
- [ ] <a testable behavior — a failing test can be written for it directly>

## Testing Decisions
<which existing suites to extend (reuse-first); create new only for genuinely new surface>

## Key Decisions
<decision-complete, slice-local when rendered as a sub-issue>

### Data Contracts                                                     (PRD tier, when interfaces change)
<shapes, invariants, ownership>

## Constraints & Invariants
<what must remain true>

## Prior Art
<modules / demos / pulses to read first>

## Source
<Part of #N · durable-record link · Blocked by #N — human-readable mirrors of native edges>

## Notes
<everything else>
```

## Density tiers

| Tier | When | Body |
|---|---|---|
| **chore** | localized fix, small ask, **development-gate auto-create** | title + one-paragraph `**Problem**` + optional short Acceptance Criteria — the issue IS the whole record |
| **standard** | a single-slice feature or fix | decision surface + Acceptance Criteria + Testing Decisions + Key Decisions + Constraints & Invariants |
| **PRD** | multi-slice design-of-record (the input `break-into-subissues` decomposes) | the full layout, incl. Approaches Considered + Data Contracts |

## Procedure

### 1. Gather the content
- From `brainstorming`: the approved design-of-record.
- From `break-into-subissues`: one slice spec per call (Acceptance Criteria, Testing Decisions, Key Decisions, Source lines).
- From the development gate: the user's ask, verbatim enough to title faithfully.

### 2. Choose the density tier
Gate auto-creates are always **chore**. A single deliverable is **standard**. A design that will be decomposed is **PRD**. When in doubt, drop a tier — ceremony on a small issue is waste; a missing why on a big one is churn.

### 3. Draft locally (scratchpad)
Render the body to the **personal vault's `scratchpad/`** (the `rw`/`kind=personal` mount — resolve it via the `amico-vault` rules, never hardcode the mount name). Nothing outward-facing exists yet: no issue, no branch, no PR.

### 4. Resolve repo + labels
The code-owning repo is the target. Ensure the `afk` and `hitl` labels exist there (`gh label create <name> -R <owner>/<repo>` if absent). Apply the label the caller supplied; the gate's auto-create defaults to `hitl` (safe default — an unlabelled issue is treated as HITL by `implement-issue`).

### 5. Approval gate
- **standard / PRD** — present the local draft and publish only on explicit user approval ("nothing outward-facing before approval", per `brainstorming`). Present it **rendered, not raw**: decision surface as a skimmable card, Acceptance Criteria as a checklist, and mathematical content typeset — inline LaTeX for symbols ($\hat H$, $\Omega_{\max}$), display equations for objectives and derivations, quantities in the researcher's notation (`F = 0.9982`, `2.1e-4`, tabular-nums where digits align). This is the **same render `implement-issue` shows at pickup** (its Step 1.5) — the approver and the implementer see the same brief.
- **chore** — **auto-publish**. The chore tier exists to unblock development the moment the gate fires; an approval prompt would defeat it. Say what was created in one line and proceed.

### 6. Create the issue
```bash
gh issue create -R <owner>/<repo> --title "<title>" --body-file <scratchpad-draft> [--label afk|hitl]
```
Capture the issue number from the printed URL. Creating the issue creates **no** branch and **no** PR — the branch is born at `implement-issue` pickup, the draft PR at its first commit.

### 7. Board placement
The org Projects board is the source of truth for status. Columns: Backlog, Ready, In Progress, In Review, Blocked, Done.

- **a. Read the Status options** — `gh project field-list <N> --owner <org> --format json`, take the `Status` field's options.
- **b. Read assignable users** — `gh api repos/<owner>/<repo>/assignees --jq '.[].login'`.
- **c. Add the card** — `gh project item-add <N> --owner <org> --url <issue-url> --format json` → the item id.
- **d. Set assignee** — `gh issue edit <n> --add-assignee <login>` (when resolved).
- **e. Set the Status column** — `gh project item-edit --project-id <projectNodeId> --id <itemId> --field-id <statusFieldId> --single-select-option-id <optionId>`. This is the mechanism every other skill references for board moves (`implement-issue`'s In Progress / In Review / Blocked transitions, `break-into-subissues`' initial Blocked mirroring).

**Degraded path (external contributor):** if the user's `gh` auth has no access to the org board, **skip Step 7 silently** — the issue and PR still happen; only the card is absent. Never block issue creation on board access.

**Batched callers:** when `break-into-subissues` passes a status/assignee resolved once for the whole slice set, apply it without prompting — don't ask N times for N slices.

### 8. Return
```yaml
number: <n>
url: <issue-url>
node_id: <I_kwDO…>    # gh issue view <n> --json id --jq .id — break-into-subissues needs it for native edge wiring
```

## Invariants

- Nothing outward-facing before approval — the **chore tier is the sole exception** (it auto-publishes to unblock the development gate).
- No file paths, no code in issue bodies.
- Body-text references (`Part of #N`, `Blocked by #N`) are **human-readable mirrors** of native GraphQL edges — never the source of truth; `break-into-subissues` Step 6 wires the real edges.
- An unlabelled issue is treated as HITL downstream — label deliberately.
- Never create a branch or PR at issue-creation time.
- Never block on board access — degrade to silent skip.

## Composition

- **Called by** `brainstorming` (standard/PRD design-of-record), `break-into-subissues` (once per slice, chore tiers excluded), and the **development gate** in `AGENTS.md` (chore tier, auto-publish).
- **Consumed by** `implement-issue`, which parses the sections this skill writes (Acceptance Criteria → the RED list; Testing Decisions → the reuse map), and by `develop`, which reads the native edges rather than the body.

## Related skills

- **brainstorming** — produces the design this skill renders.
- **break-into-subissues** — decomposes a published PRD-tier parent into slices rendered through this skill.
- **implement-issue** — implements the issues this skill creates.
