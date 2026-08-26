---
name: deliberate
description: "Use before any substantial work — a spec, adversarial review by independent critics, then a compiled plan with tracked obligations. Turns 'let's build X' into a falsifiable spec that survived criticism."
agents: [researcher, experimenter, engineer]
surface: public
scenarios: [spec-underspecified-must-block, spec-adequate-must-pass]
vault_contract:
  folders: [specs, plans]
  note_types: [spec, plan, spec-review]
  tags: [deliberation]
---

# Deliberate: spec → adversarial review → compiled plan

Most wasted work is not badly executed. It is well-executed work on a goal nobody made
falsifiable, using a budget nobody bounded, against a baseline nobody looked up.

This skill is three artifacts and two gates:

```
  spec  ──▶ amico spec review ──▶ amico plan compile ──▶ tracked obligations
   │            (critics)              (budget gate)
   │
   └─ falsifiable acceptance, a bounded budget, a named baseline
```

## Usage

`/deliberate` — start a spec. `/deliberate review <path>` — review one you already have.

The argument is: $ARGUMENTS

## Instructions

### Step 0 — check what is available

```bash
command -v amico >/dev/null && amico spec review --help >/dev/null 2>&1 && echo tooling || echo manual
```

**`tooling`** — run the loop below with the real verbs. **`manual`** — you still do every step,
by hand, using the checklists here. The value is in the *discipline*, and the tooling only makes
it cheap and recorded. Never skip the review because the binary is missing; say that it was done
by hand, which is a weaker claim and should read as one.

### Step 1 — write the spec

One dialogue rule: **ask one question at a time.** A wall of questions gets a wall of shallow
answers.

Write to `<vault>/specs/spec-<YYYYMMDD-HHMMSS>-<slug>.md`:

```yaml
---
type: spec
schema_version: "1"
spec_id: spec-20260728-093846-cz-gate-on-two-atoms   # IMMUTABLE once written
task_type: experiment-sim        # see the table below
acceptance:
  - F_free >= 0.999              # metric · comparator · threshold. NOT prose.
  - wall_s <= 600
invariants:
  - the pulse stays within device drive bounds     # prose is FINE here
budget: { max_solves: 8, tier: free, device: none }  # launch-shaped work only
baseline: { value: 0.968, source: "published blockade-π protocol" }
---
```

#### `acceptance` is machine-checked, and this is the one thing people get wrong

Every entry must match:

```
<metric_name> <comparator> <number>
```

- comparators: `<=` `>=` `==` `<` `>`
- the metric may be dotted (`outcome.fidelity`), the number may be scientific (`1e-4`) or a
  percentage (`100%`)

| ✅ | ❌ | why the ❌ fails |
|---|---|---|
| `F_free >= 0.999` | `high fidelity` | no threshold — nothing can ever fail it |
| `leakage <= 1e-4` | `minimal leakage` | "minimal" is a feeling |
| `wall_s <= 600` | `runs reasonably fast` | unfalsifiable |
| `n_iters == 3` | `converges` | to what? |

If a criterion genuinely cannot be a number, it is an **invariant**, not an acceptance criterion.
`invariants` takes prose on purpose — some things really are qualitative, and forcing a fake
number on them is worse than admitting it.

#### `task_type` decides which checks apply

| task_type | launch-shaped? | needs `budget` |
|---|---|---|
| `experiment-sim`, `experiment-hw`, `author-script` | yes | **required** |
| `implement-slice`, `plan`, `review`, `insight`, `triage`, `bookkeeping`, `converse` | no | **forbidden** |

Launch-shaped means it spends compute. **Do not mislabel to dodge the budget:** the compiler
refuses a non-launch-shaped spec that compiles to a solve-bearing step, because the mislabelling
would silently switch off two blocking checks on work that spends real money.

#### `baseline` is required for launch-shaped work, and "none" is a legal answer

```yaml
baseline: { value: 0.968, source: "published blockade-π protocol" }
# or, honestly:
baseline: { none_because: "first attempt at this gate on this geometry" }
```

A number with no source is refused. So is silence. `none_because` is always available — the point
is that *"we never checked"* cannot pass as *"there is no baseline"*.

### Step 2 — review it adversarially

```bash
amico spec review <spec-path> --json          # add --offline to skip the critics
```

**Two tiers, and the first one is free.**

*Tier 1* is mechanical: schema, falsifiable acceptance, budget legality, baseline presence,
precedent, provenance. Deterministic, no model call, and it **blocks** — so a spec with prose
acceptance never reaches a paid critic. Fixing tier-1 findings costs nothing but attention.

*Tier 2* is judgment: independent critics, **one lens each**, each seeing only the spec file and
no conversation history. One lens each rather than N identical reviewers, because
perspective-diverse critique catches failure modes redundancy cannot.

**What critics may and may not do.** A critic can mark a finding `blocking` only for
`contradiction` — two lines of your spec that cannot both be true, both quoted. Everything else
is `advisory`, however severe. This is enforced in code, not requested.

That is not critics being toothless; it moves their teeth downstream. **Every advisory becomes an
obligation, and a plan cannot be completed while one is open.** Critics shape the work and gate
*finishing*, never *starting*.

| verdict | exit | what it means |
|---|---|---|
| `approved` | 0 | tier 1 clean, critics ran and agreed |
| `approved-mechanical` | 0 | tier 1 clean, **no critic was ever available** — say so out loud |
| `degraded` | 0 | a critic was available and failed (timeout, unparseable) |
| `blocking` | 65 | revise and re-run; `round` goes up |
| `exhausted` | 66 | three rounds of blocking — stop and get a human |

`approved-mechanical` and `degraded` both exit 0. **They are not the same as `approved`**, and
reporting either as "reviewed" is the specific dishonesty this vocabulary exists to prevent.

Round budget is **3**. If you are still blocking at round 3, the spec is not the problem —
the understanding is.

### Amendments to approved specs are first-class specs

An amendment gets the same review budget as the original: three lenses, round
budget 3, before it lands in the spec's record. The documented failure mode
(two same-day incidents, 2026-08-22) is the **cheap-talk amendment** — drafted
as summary prose from conversation momentum, it contradicted the frozen
contracts it amended (enumerated lists, tier memberships, invariants,
criteria preconditions, cross-spec pointers) six and nine times respectively,
caught only by post-hoc review.

Rules:

- Before drafting: re-read the parent spec's frontmatter invariants, every
  D-decision, the Measurement Protocol, and all prior amendments — line by
  line. Draft from the spec text, not from the conversation.
- An amendment that edits any enumerated list, tier membership, invariant,
  criterion precondition, or cross-spec obligation must be checked against
  the exact text it edits, and against every sibling amendment for
  cross-conflicts.
- Run this skill's Step 2 loop on the amendment itself before recording it.
- A same-day revision note records that a review happened; it is not a
  substitute for the review.

### Step 3 — compile the plan

```bash
amico plan compile <spec-path> --json
```

The planner turns the spec into ordered steps. Each step declares `model`, `task_type`, `gates`,
`needs`, and `permissions.device` when it touches hardware. `model` and `task_type` are required:
the compiler sums solve-bearing steps against `budget.max_solves` and joins device demands against
`budget.device`, and a step that omits them would make that check silently pass.

**A below-frontier step with no gate is refused.** Cheap unverified work is how a plan reports
progress it did not make.

Compile refuses, before writing anything, if:

- the plan needs more solves than the budget authorises (it names the margin)
- the plan demands more device access than the budget authorises — **or the budget does not
  mention device at all**, because an omitted bound is not permission
- the latest review was `blocking` (`--allow-unreviewed` does **not** override this)
- the spec was never reviewed, or only mechanically, and you did not pass `--allow-unreviewed`

It also tells you what it *could not* check: `tier` and `max_size_class` are properties of a
resolved solve, which does not exist yet, so they are refused later at launch. "Compiled" does not
mean "fully budget-checked", and the output says which.

Compiled plans are **not hand-editable**. An approved warrant is bound to `plan_hash =
sha256(canonicalJson({goal, steps}))`; editing the file detaches the two silently. Change the
spec and `--recompile`.

### Step 4 — work the plan

```bash
amico plan status                                  # derived, not self-reported
amico plan advisory <id> --state fixed
amico plan advisory <id> --state waived --reason "out of scope for this slice"
amico plan advisory <id> --state obsolete
```

**Step state is derived from gate verdicts. There is no command to set it.** Not as a policy —
there is no write path. An agent cannot mark a step `passed` without a gate having agreed, which
is the same barrier that protects every fidelity claim in the system.

Advisories *are* movable, because closing one is genuine judgment rather than a fact a gate
established. `waived` requires a reason, so waive-spam is visible in the record instead of silent.

```
plan state:  active → complete | stalled

complete ⟺ every step passed or skipped   AND   every advisory closed
stalled  ⟸ a step's gates were exhausted, or the replan budget ran out
```

Both conjuncts matter. Without the second, "all done" would mean "the gates passed and we ignored
every critic".

## When to skip this

Genuinely trivial and reversible work — a typo, a comment, a one-line config change with an
obvious right answer. The test is not size, it is **whether you could be wrong in a way that
costs something.** A three-line change to a fidelity threshold deserves a spec. A five-hundred-line
mechanical rename does not.

## The failure this prevents

The recurring defect in this codebase's own history has one shape: **a check that reads a field its
schema does not carry.** A counter keyed on a forbidden field, so a bound authorised unlimited
spend while reading as enforced. A derivation reading fields its branch forbade, so a state was
unreachable while the completion rule admitted it. A comparison whose two sides spoke different
vocabularies.

Every one shipped through a spec that *sounded* right, and every one was caught by an independent
critic reading only the artifact. When your spec asserts a cross-module check, ask what the values
on **both** sides actually are — and whether the spec ever says.

## Related

- `amico-vault` — where specs and plans live, and the frontmatter schema
- `break-into-subissues`, `implement-issue` — the issue-tracker path, once a plan exists
- `verification` — what a gate is and how to choose one
