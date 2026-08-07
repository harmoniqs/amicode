---
name: report-a-bug
description: File a sanitized, intake-grade bug issue from a live Amicode session — auto-collected diagnostics, at least one question (accepts user follow-ups), confirm gate, silent dedup, pin-aware upstream check for the vendored engine. Use when the user hits a bug in Amicode (the extension, the run gate, the Run Inspector, vetted templates, the engine, or a toolchain package) and wants to report it.
agents: []
surface: public
---

# Report a Bug

**Announce at start:** "I'm using the report-a-bug skill to file this."

File an **intake-grade** bug issue from a live session. Capture stays cheap — auto-collected, sanitized diagnostics plus at least one user question — and readiness is earned later at review, per the **maturity contract** below. This skill is capture-only: it files intake issues and publishes the contract a reviewer matures them by. Feature ideas, designs, and specs are out of scope — a bug filer has a symptom, not a resolved design.

**The flow:** read the context envelope (when the session carries one) → classify the surface → capture (at least one question) → sanitize → dedup → upstream check (fork surfaces) → compose → confirm gate → file → print the filed sentinel. **Nothing posts before the confirm gate; the sentinel prints after any successful GitHub action (issue created OR comment posted).**

## 0. Read the context envelope (when the session carries one)

A bug session may carry a **context envelope** in its session metadata: a `bug_report` key with fields `project` (string, optional), `run_pointer` (string, optional), and `origin_session_id` (string, optional), written by the extension that spawned the session. **Read it first, silently — it precedes every context question and is never a user prompt.**

- **Envelope present** → collect from the envelope *in place of* the live session: `project` seeds the step-1 surface classification; `run_pointer` (when present) is the run-id pointer for the step-2 diagnostics — platform/tier and the bounded log tail resolve locally through it. Never ask the user for run context the envelope already carries; the one content question (step 2) is still asked, unchanged. `origin_session_id` is local provenance for the session the bug came from — it is never posted.
- **Envelope absent** → collect from the live session exactly as the steps below describe; behavior is unchanged.
- **Pointer-only, always** — envelope run context travels as a pointer only: never expand `run_pointer` (or anything resolved through it) into absolute paths in any artifact, including the confirm-gate draft. Envelope content is already scrub-safe by construction; the step-3 sanitize pass applies to it unchanged.

## 1. Classify the owning surface (silent — never a user prompt)

Decide where the bug lives, from the session context:

- **Product surfaces** — the extension, the run gate, the Run Inspector, the vetted templates → the public product repo (`harmoniqs/amicode`).
- **The vendored engine** (a fork-vendored component) → the fork repo (`harmoniqs/opencode`), and step 4's upstream check applies.
- **A toolchain package** → its owning repo. Repo inference for toolchain packages runs on the **internal path only** (step 7); on the public path the filing lands in the product repo and triage re-routes.

## 2. Capture — at least one content question, plus user-initiated follow-ups

Ask the user directly, as plain text output: **"What happened, and what did you expect?"** Do not use the `question` tool — the bug dock handles the dialogue natively. Output the question as your message text and wait for the user's reply. Everything else is auto-collected or deferred to maturation review. Never ask follow-up questions yourself — gaps are the reviewer's job.

**After this question, the user may send unsolicited follow-up messages** through the always-available textbox — additional context, clarifications, or corrections. Accept them silently (never ask another question) and fold them into the draft as extra detail. The user drives any follow-up; the agent never escalates.

(The dedup-hit and upstream-hit offers and the confirm gate are gates, not content questions.)

**Auto-collect, locally, held unposted until scrubbed:**

- Extension version (`code --list-extensions --show-versions`, or the installed `harmoniqs.amicode-*` extension directory name) and OS (`uname -srm`).
- The engine pin: `opencode.lock.json` under the installed extension directory — its `version`, `tag` (e.g. `v1.18.10-amicode.1`), and `repo`.
- **When a run is active** (a solve this session, or the bug is about a run): platform and tier from the problem workspace (`~/.amico/problems/<slug>/` — `solvespec.json` / `events.jsonl`), the **run-id pointer** (`runs/<lab>/<runId>`, relative to `~/.amico/` — a pointer, never an absolute path), and a **bounded log tail** (last ~40 lines of that run's `run.log`). When the session carries the `bug_report` envelope (step 0), this run context comes from the envelope's `run_pointer` instead of live-session discovery — same pointer form, same bounded tail.
- **Never collected:** absolute paths, binaries or screenshots, vault contents, and lab secrets (device frequencies, calibration values) — lab context travels as run-id pointers only.

## 3. Sanitize — classify → scrub → compose

Sanitization is **architectural, not procedural**: the draft is built only from scrubbed material, so sensitive content is absent by construction rather than caught by review.

1. **Classify the taint** of the collected material: does the failure context touch proprietary code (private paid packages, private exemplars) or lab secrets? **Doubt tilts proprietary.**
2. **Scrub before any drafting.** Drop proprietary stack frames, symbols, source excerpts, and package names; lab secrets become run-id pointers. The scrub covers the auto-collected diagnostics **and the user's free-text answer**, and binds on every later search query (dedup, upstream) — a proprietary-flavored symptom never becomes a query string on a public tracker.
3. **Compose** the draft only from scrubbed material.

Scrubbing is keyed to **content taint, not destination repo** — even a misrouted filing is a scrubbed filing. Proprietary diagnostics travel by pointer (the run id), never payload; the entitled reviewer follows the pointer locally. Marker wording differs by path (step 5 footer): public filings carry the bland `diagnostics: pointer-only`; internal filings may carry the explicit `sensitivity: proprietary-scrubbed`.

## 4. Dedup + upstream check — silent unless they hit

Both are read-only searches with **scrubbed terms only**, run before drafting so their results feed the footer. Silent on no match. If `gh` is unavailable or unauthenticated, skip both checks silently — the browser fallback in step 7 still files, and the footer records no upstream claim.

- **Dedup.** Search the target repo's open issues (`gh search issues --repo <target> --state open`). On a likely-match open issue, offer **comment-on-existing vs file-anyway** — the only conditional prompt besides the gates.
- **Upstream check (fork-vendored surfaces only — today, the vendored engine).** The pin makes "does the fix already exist upstream?" mechanically decidable: parse the release tag's upstream base (`v<base>-amicode.<n>` → `v<base>` of `sst/opencode`), then search upstream issues **and** PRs with scrubbed terms:
  - **A matching merged fix** (merged PR / closed-as-fixed issue) at a release newer than the vendored base → offer an **upstream-bump chore issue instead of the `BUG:` filing** (merge the newer upstream; never re-implement what upstream already fixed).
  - **A matching open upstream issue** → file the intake bug normally, footer `upstream: sst/opencode#N (open)` — maturation watches rather than implements.
  - **No trace** → footer `upstream: none found`.

## 5. Compose the intake issue

**Title:** `BUG: <one-line symptom>`

**Body:**

```
## Summary                      — one paragraph, from the scrubbed answer
## Context                      — extension version, OS, engine base; what was happening
## Expected vs actual           — the scrubbed expected/actual pair
<details><summary>Diagnostics</summary>

- platform / tier, run-id pointer (runs/<lab>/<runId>) when a run is active
- bounded, scrubbed log tail
- no absolute paths, no binary uploads

</details>

---
intake: not-ready — mature per the maturity contract before picking up
suggested_path: A | B
diagnostics: inline | pointer-only        (public path)
sensitivity: proprietary-scrubbed          (internal path, when scrubbed)
upstream: n/a | none found | sst/opencode#N (open)
```

The `intake: not-ready` footer (plus the intake label/column on the internal path) is what makes the issue **visibly not-ready**. `suggested_path` is the agent's maturity-path suggestion: `A` only when all four Path-A criteria below are clearly met from the filed diagnostics; **any uncertainty → `B`**; the human can veto it at the confirm gate.

## 6. Confirm gate — nothing posts before it

Show the user **the exact final body, the target repo, and the `suggested_path`** — the draft is already scrubbed, so nothing proprietary is displayed either. Tell the user, as plain text output: **"The draft above is ready. Reply `file it` to submit as a new issue, `edit: <changes>` to modify before filing, `comment: <repo>#<issue> <text>` to add a clarifying comment to an existing issue, or `veto` to cancel."** Do not use the `question` tool. Wait for the user's reply. Never ask follow-ups — the confirm gate is a single prompt.

On answer: starts with "file it" → file exactly as drafted (step 7). Starts with "edit:" → incorporate the text after "edit:" and file (step 7). Starts with "comment:" → parse `<repo>#<issue> <text>` (e.g. `comment: harmoniqs/amicode#123 Thanks — confirmed on my end`), post the comment via `gh issue comment <issue> --repo <repo> --body <text>`, then **print the sentinel on its own line exactly as**: `AMICODE_BUG_FILED https://github.com/<repo>/issues/<number>` (the full URL of the issue you commented on — construct it from the repo and issue number), and end. Starts with "veto" → file nothing, no sentinel. **The sentinel prints after EVERY successful action — new issue OR comment. The only path that skips the sentinel is "veto."** No issue, comment, or unscrubbed query leaves the machine before this gate.

## 7. File — the runtime org-tail fork

One skill for every filer. The **org tail** (private-repo routing, board placement, intake labels) runs only when **both** hold at filing time; otherwise the public path runs:

- **Checkout presence** — internal-surface skills are staged in the session's skill index (e.g. `write-an-issue` is resolvable). Checkout presence is the eligibility proof: internal skill content exists only in a private plugin checkout.
- **Org access** — `gh auth status` succeeds and the org board is readable.

**Public path (default).** File to the public product repo (`harmoniqs/amicode`) with a `bug` label (resolve the label live; file without it if absent) and **no board placement**. Public filings always land there — even when the symptom points at a public toolchain package; triage re-routes. **No `gh` auth?** Fall back to opening a pre-filled new-issue URL in the browser (`https://github.com/harmoniqs/amicode/issues/new?title=…&body=…`); URLs have a practical length limit, so truncate the diagnostics block and keep the run-id pointer.

**Internal path (org tail).** Route to the owning repo per step 1 (product surfaces → `harmoniqs/amicode`; engine → `harmoniqs/opencode`; toolchain packages → their owning repos, including private ones — private-repo routing is the point of this path). File **unassigned**, with labels resolved live (`bug` plus an intake-flavored marker such as `intake`/`triage` if it exists — never create labels; fall back to board-column-only marking). Then place the issue on the org SCRUM board (GitHub Projects, org `harmoniqs`, number `4`) in an **intake-flavored column**: read the live Status options (never hardcode), pick the option whose name matches intake/triage, fall back to **Backlog**:

```bash
# a. live Status options → project id, field id, option ids
gh api graphql -f query='query($org:String!, $num:Int!){ organization(login:$org){
  projectV2(number:$num){ id field(name:"Status"){ ... on ProjectV2SingleSelectField {
    id options { id name } } } } } }' -f org=harmoniqs -F num=4
# b. add the issue → item id
gh api graphql -f query='mutation($project:ID!, $content:ID!){ addProjectV2ItemById(
  input:{projectId:$project, contentId:$content}){ item { id } } }' \
  -f project=<PROJECT_ID> -f content=<ISSUE_NODE_ID>
# c. set the Status column on the new item
gh api graphql -f query='mutation($project:ID!, $item:ID!, $field:ID!, $opt:String!){
  updateProjectV2ItemFieldValue(input:{ projectId:$project, itemId:$item,
  fieldId:$field, value:{ singleSelectOptionId:$opt } }){ projectV2Item { id } } }' \
  -f project=<PROJECT_ID> -f item=<ITEM_ID> -f field=<STATUS_FIELD_ID> -f opt=<OPTION_ID>
```

`<ISSUE_NODE_ID>` = `gh issue view <n> --repo <target> --json id --jq .id`. No status or assignee prompts — the intake defaults are fixed (intake column, unassigned).

**The filed sentinel — the terminal contract.** This is a **lifecycle signal**, not a semantic judgment. Print it after ANY successful GitHub action in this session — new issue created, comment posted, chore filed — regardless of whether the content is a "bug." The sentinel tells the dock "you're done; show the end-state." Without it the dock stays open forever.

- **After creating an issue via `gh`**: print `AMICODE_BUG_FILED <url>` with the new issue's URL, e.g.
  `AMICODE_BUG_FILED https://github.com/harmoniqs/amicode/issues/123`.
- **After posting a comment via `gh issue comment`**: print `AMICODE_BUG_FILED https://github.com/<repo>/issues/<number>` with the issue's URL.
- **After the browser fallback**: print the sentinel carrying `filed-via-browser` — or the pre-filled new-issue URL as the token when one was opened.

This line is a machine contract, not prose. The sentinel is **its own line** in your text output, the marker and its single token separated by a space, and nothing else on the line (no markdown, no backticks, no punctuation glued to the token). **Never print it before a successful GitHub action** — a veto means nothing was posted and no sentinel ever appears. The sentinel is the lifecycle trigger that archives the bug session; printing it without an action would archive a session whose report never reached GitHub.

## The maturity contract (the reviewer-facing interface)

Intake issues **mature in place** to ready-for-agent, through one of two paths delineated by bug shape:

- **Path A (reviewer agent / light review)** requires **all four** criteria: **(1)** deterministic repro from the filed diagnostics; **(2)** single owning surface; **(3)** no contract at stake; **(4)** the fix needs no design choice.
- **Path B** is everything else: escalate to HITL through the design pipeline (brainstorming + a grilling skill). **Any uncertainty resolves to HITL** — the cost of misrouting is asymmetric.

**Designation flow:** the agent suggests `suggested_path` at filing → the call is **re-checked against the four criteria at review** → the human holds a **veto at the confirm gate**. The whole flow tilts toward the human.

**Exit format:** maturation rewrites the issue in place to the **bug-variant decision surface** — the canonical two-reader layout (`> [!IMPORTANT]` decision surface over execution detail), `BUG:` title prefix preserved. `write-an-issue` is the format authority for the exit state; it ships `surface: internal`, so only team reviewers execute maturation — never invoke it from this skill.

**Footer fields** the reviewer consumes: `suggested_path`, the diagnostics marker (`diagnostics: pointer-only` / `sensitivity: proprietary-scrubbed`), and the `upstream` status.

**Two reviewer clauses:**

- **Fork-surface upstream re-check.** For bugs on a fork-vendored surface, the reviewer re-checks upstream at review time. A fix landed since filing → close the bug as **fixed-by-upstream** and spawn the bump chore.
- **Entitled review of scrubbed filings.** A proprietary-scrubbed filing cannot satisfy Path A's "repro from the filed diagnostics" without following the run-id pointer to full diagnostics — which correctly forces an entitled human to hold the review.

Until a reviewer-agent skill exists to execute maturation, humans mature intake issues.

## Invariants

- **At least one content question** at capture — the agent asks exactly one opening question and accepts unsolicited user follow-ups as additional context; never asks a second question itself. Everything else is auto-collected, a gate, or a conditional offer.
- **Nothing posts before the confirm gate** — and the gate's draft is already scrubbed.
- The **filed sentinel prints after any successful GitHub action** (issue created, comment posted, chore filed) — never before the confirm gate; a veto means no sentinel, ever. The sentinel is a lifecycle signal, not a semantic judgment about whether the content is a "bug."
- **Envelope context is pointer-only** — `run_pointer` is never expanded into absolute paths in any artifact, including the confirm-gate draft; envelope absent → live-session collection, unchanged.
- Intake issues are **visibly marked not-ready** (footer; label + column on the internal path).
- **No proprietary implementation details or package names** in any artifact that leaves the machine — including the draft shown to the user.
- **No lab secrets in payloads** — run-id pointers only.
- The **org tail never runs** without both checkout presence and org access.
- **Public searches carry scrubbed terms only** (dedup and upstream alike).

## Composition

- `write-an-issue` — the format authority for the maturity exit state (internal; not staged on public installs, and not invoked by this skill).
- The design pipeline (`brainstorming` + a grilling skill) — the Path-B destination.
- The idea hopper explicitly excludes bugs — this skill is why.
