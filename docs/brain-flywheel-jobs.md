# Brain flywheel jobs — the curation motions on cadence (slices 6, 8 + 9, #1685 / #1687 / #1688)

The dream cycle's manual invocations — `/dream promote`, `/dream prune`,
`/dream synthesize` (and the `/dream` orchestration that wrapped them) — are
**retired**. Their curation semantics now run as warranted Notturno jobs over
the claims registry: small TS verbs in the `amico` CLI, registered in the job
registry, receipted in the scheduled-passes journal, testable in isolation.
This page is the jobs' documentation of record — what each job does, its
cadence, its registry row, and its trust boundaries.

The verbs (all dry-run by default, `--apply` writes):

| job | verb | cadence | what it does |
|---|---|---|---|
| `promote` | `amico claims promote` | weekly | scope-team live claims → ONE PR-body bundle per vault, 10-cap, **proposes only**; `--tier public` (#1688) targets the kind: public mount — the brain's outbound face |
| `prune` | `amico claims prune` | weekly | schema-check (the claims lint) + unambiguous hygiene fixes; drift flagged for a human |
| `synthesize` | `amico claims synthesize` | weekly | cross-claim tag clusters → hopper proposals, **never strategy** |
| `brain-health` | `amico brain-health` | monthly | the five KPI families over pass receipts + claim state → the dated brief; **measures, never acts** (#1687) |

Slices 1–5 of the flywheel (#1680 distill, #1681 claims schema, #1682 render,
#1683 stamp/sweep, #1684 lifecycle) feed these jobs: they operate on the
claims registry those slices built.

## promote — one PR per vault, never auto-merged

`amico claims promote [--registry <dir>] [--state <p>] [--out <bundles>]
[--from <vault>] [--apply] [--jobs <notturno.toml>] [--dashboards <dir>]`

Eligible claims: `scope: team`, a live status (`unverified`/`corroborated`),
not already proposed (the promote state stamp). Terminal (superseded/refuted)
and `scope: public` claims are excluded **by name** in every result — never
silently dropped; personal claims are simply out of the pool.

The output is one promotion **bundle** per run (default
`<registry>/promotions/promote-YYYYMMDD-HHMMSS/`): a `PR-BODY.md` (the
proposal: the claims table, the carried overflow, the exact human-run `gh pr
create` step) plus one copy per claim — the claim note verbatim with a
provenance footer. Copy-never-move: the source claims stay.

The cap is 10 per bundle; overflow carries to the next run (the state stamp
never strands a claim). A bundle that already exists is never clobbered — it
is the audit artifact.

**The double gate is the trust boundary** (the spec's Key Decision): gate 1 is
the author tagging `scope: team` (why a claim is eligible at all); gate 2 is a
**human** reviewing the bundle, opening the PR, and merging it. The verb has
no git, no `gh`, no network — it **proposes**; auto-merge is structurally
impossible. Only after a merge does anything change downstream (the
merged-PR writeback of promotion stamps is a later, human-anchored step —
the dream-promote Step 1 semantics).

## promote --tier public — the brain's outbound face (slice 9, #1688)

`amico claims promote --tier public [--to <mount>] [--vault <root>] ...`

The same weekly job, the same bundle machinery, the outer destination: the
pool is `scope: public` live claims, and the destination is the mount of
kind `public` — resolved by the mount-stack conventions (the
`.amico-vault.toml` marker, `kind = "public"`, read precedence's last
position), **verified, never guessed**: `--to` overrides and is itself
marker-verified (a non-public `--to` is refused); no public mount and no
`--to` → refused. There is no second promotion path — one job id, two tiers.

**The two-note visibility split is checked at promotion time** (#1688's AC): a
claim is **refused by name** — never silently dropped, never stamped, back in
the pool next run — when either taint class fires:

- an evidence pointer resolving into **private-mechanism content** (a
  `visibility: local` note; absent visibility is the vault default local);
- a `mechanism:` **wikilink to a local note** carried in the claim's own
  note (the public-safe half's pointer to its private mechanism).

Chat / paper / meeting-note pointers are substrate provenance ids — opaque,
content-free — they pass: one substrate, provenance intact on every copy.
The check is mechanical (pointers + links); the author owns the statement's
text.

The public bundle carries a third artifact: `INDEX.md`, the public vault's
claims index, **generated from the bundle's claims** — the public tier is
generated, never hand-authored; hand-edits are regenerated away by the next
bundle. The copies' provenance footers carry `promoted_from` **and**
`promoted_to` — the both-ways stamps; the source claim's own `promoted_to`
writeback remains the merged-PR-driven human step.

Live seam, honestly: no `kind: public` mount and no `scope: public` claims
exist on this machine yet — the test fixtures construct both (the committed
public-registry + public-mount fixtures), and the first real run lands when
the org stands up a public mount and authors public-safe claims into it.

## prune — hygiene diffs + flagged drift

`amico claims prune [--registry <dir>] [--vault <root>] [--db <chat.db>]
[--apply] ...`

The schema-check **is** `amico claims lint`, reused verbatim: every claim
validates against the ONE contract and every evidence pointer resolves. The
lint's findings are **drift** — a human owns them (an invalid claim, an
unresolvable pointer: never "fixed" by deletion, never re-typed locally).
Findings exit 1, the lint's convention.

What the pass applies (`--apply`) is only the **unambiguous** frontmatter
fixes, each provably still a valid claim after the fix:

- duplicate evidence pointers → deduplicated (order preserved);
- whitespace-padded / duplicate tags → normalized.

The apply path swaps exactly the frontmatter (prose is preserved
byte-for-byte — machinery never edits prose). The result JSON carries the
hygiene diff and the drift list; drift present still exits 1 after the fixes:
the pass acted, and the registry still needs a human.

## synthesize — cross-claim patterns → the hopper

`amico claims synthesize [--registry <dir>] [--hopper <dir>] [--apply] ...`

A mechanical pattern pass over the **live** claims: tag clusters at the
dream-synthesize quality bar (3+ independent data points; confidence high at
5+; a cluster across ≥2 types is marked cross-cutting). Each pattern becomes
ONE hopper note (default `<vault>/hopper/synthesize-<tag>.md`, the hopper
skill's schema, `status: proposed`, machine provenance in the note). Capped
at 5 new proposals per run — the hopper is never flooded; the rest carries.
Idempotent: a tag whose note already exists is a named skip.

**Synthesize proposes to the hopper, never to strategy.** Human-fed strategy
sections are human-fed by design; the verb has no code path that reads or
writes a strategy file at all. A human curates hopper items into strategy at
triage — the hopper skill's protocol.

## brain-health — the brain measures itself (slice 8, #1687)

`amico brain-health [--period YYYY-MM] --dashboards <dir|file> [--registry
<dir>] [--candidates <dir>] [--state <distill-state.json>] [--queue
<review-queue.md>] [--meetings <root>] [--out <file>] [--apply]`

The monthly KPI report over the flywheel's own pass receipts + claim state —
the five families the #1679 census named: **claims created vs applied**
(created from the distill receipts' own counts, applied from the registry's
`applied` history events), **time-to-distill** (the candidate notes' own
`distilled_at` vs `session_updated`), **pending backlog trends** (the distill
backlog = latest receipt's substantive − the state stamp's ever-distilled;
the review queue's own rendered count; the pending-tag intake from the
extract-meetings receipts + the meetings vault's own status frontmatter),
**refutation rate** (refuted / (refuted + corroborated) history events in
period + the registry snapshot), and **schema compliance** (the prune
receipts' own drift-finding counts).

Published as a dated brief in the vault's briefs area, period-keyed:
`briefs/health-YYYY-MM.md` — **idempotent per period** (a re-run overwrites
its own brief, the re-distill doctrine; each month's brief is the trend
carrier). Every number carries the provenance that produced it (receipt
dates, claim files); an unmeasured family is stated, never faked as zero; a
receipt whose outcome left its writer's pinned shape is a named finding, not
a silent skip.

**The report measures, never acts** (#1687's Key Decision): every substrate —
the receipts journal, the registry, the candidate area, the review queue, the
meetings vault — is opened READ-ONLY. The only bytes an apply run writes are
the brief itself (atomically) and the pass's own receipt. No fixes, no
stamping, no transitions ride this pass.

The registry row it honors (the membership key the receipt path checks):

```toml
[job.brain-health]
workflow = "notturno-brain-health.yml"
cadence  = "0 6 1 * *"        # the 1st of the month, 06:00 UTC (monthly, per the spec)
surface  = "mini"
warrant  = "report"           # a report — the read-only warrant tier
enabled  = true
record   = "always"
```

## Receipts + cadences (the notturno chassis)

Every apply run files (or honestly skips) a scheduled-pass record when
`--jobs <registry>` + `--dashboards <dir|file>` are given — the distill
precedent (#1680): job id in the section header, counts in the outcome,
duration, artifacts. Without `--jobs` the body still runs and the receipt is
honestly not filed. The chassis gates apply verbatim:

- the **instance deny-list** first (a deny-listed registry is refused loudly,
  exit 64, pointing at the private instance's runner — the public verb never
  runs org config; the gate fires before any body work);
- the **registry membership check** (an unknown job id is a data error,
  exit 2);
- the **record mode** (`record = "acted"` jobs self-filter when the pass did
  nothing — an honest skip, not a phantom pass).

The env fallback for `--jobs` is `AMICO_NOTTURNO_REGISTRY`.

The job registry itself (notturno.toml) is instance data — the org's rows
live in the amicissimo checkout, deny-listed from this public verb by
construction. The rows this slice's jobs register under (the cadence
contract; weekly per the flywheel spec, the ADR-0001 job record shape):

```toml
[job.promote]
workflow = "notturno-promote.yml"
cadence  = "0 6 * * 1"        # Mondays 06:00 UTC (weekly, per the spec's registry table)
surface  = "mini"              # the fleet server — the only surface that reads the vaults
warrant  = "stage"             # proposals + frontmatter fixes; PR merges stay human
enabled  = true
record   = "acted"             # records only when the pass proposed something

[job.prune]
workflow = "notturno-prune.yml"
cadence  = "30 6 * * 1"       # Mondays 06:30 UTC, after promote's proposal lands
surface  = "mini"
warrant  = "stage"
enabled  = true
record   = "always"           # the hygiene verdict is itself the deliverable

[job.synthesize]
workflow = "notturno-synthesize.yml"
cadence  = "0 7 * * 1"       # Mondays 07:00 UTC, after prune settles the registry
surface  = "mini"
warrant  = "stage"
enabled  = true
record   = "acted"
```

(`workflow` files are the private instance's; the rows above are the
contract this slice's verbs honor — job ids `promote` / `prune` /
`synthesize` are the membership keys the receipt path checks.)

## The retired manual invocations

| retired | replaced by |
|---|---|
| `/dream promote` | `amico claims promote --apply` on the `promote` cadence |
| `/dream prune` (+ schema-check) | `amico claims prune --apply` on the `prune` cadence |
| `/dream synthesize` | `amico claims synthesize --apply` on the `synthesize` cadence |
| `/dream` (the orchestration) | the Notturno registry — the jobs ARE the cycle, scheduled |

The dream skill cards remain the semantics' documentation of record; the
jobs implement them. What the manual cycle did by hand at human-remembered
intervals, the jobs now do on cadence with receipts — the flywheel's
metabolism is machinery, per spec-20261002-090500 §"the metabolism is
scheduled machinery".
