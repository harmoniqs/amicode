# Brain flywheel jobs — the curation motions on cadence (slice 6, #1685)

The dream cycle's manual invocations — `/dream promote`, `/dream prune`,
`/dream synthesize` (and the `/dream` orchestration that wrapped them) — are
**retired**. Their curation semantics now run as warranted Notturno jobs over
the claims registry: small TS verbs in the `amico` CLI, registered in the job
registry, receipted in the scheduled-passes journal, testable in isolation.
This page is the jobs' documentation of record — what each job does, its
cadence, its registry row, and its trust boundaries.

The verbs (all subcommands of `amico claims`, all dry-run by default,
`--apply` writes):

| job | verb | cadence | what it does |
|---|---|---|---|
| `promote` | `amico claims promote` | weekly | scope-team live claims → ONE PR-body bundle per vault, 10-cap, **proposes only** |
| `prune` | `amico claims prune` | weekly | schema-check (the claims lint) + unambiguous hygiene fixes; drift flagged for a human |
| `synthesize` | `amico claims synthesize` | weekly | cross-claim tag clusters → hopper proposals, **never strategy** |

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
