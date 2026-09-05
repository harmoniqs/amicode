# Seed gate — the four role cards, diffed for signature (D3, #806)

**Status: PENDING SIGNATURE — prepared by the implementing cast (slice 2, worktree `slice2-role-cards`); Aaron performs and signs.**

This is the human diff the seed gate requires (spec `spec-20260905-063000` D3,
issue #806, obligation O2). The four director-cast role cards —
**hypothesizer, experimenter, analyzer, implementer** — were seeded into the
repo **verbatim** from the live deployed staging artifacts on the seed
machine (erlich's server staging root), because those artifacts were the only
live copies: the director's casts have run on them since 2026-08-18 (this
campaign's own implementer briefing came from there), while the #758
"worker-card" authoring at the same repo paths never deployed. Deployed
artifacts are plausibly per-machine drifted — garbage-in must never be
enshrined as the tested baseline — so **nothing the diff flags as divergent is
pinned by the parity suite until this document is signed.** The flagged
anchors are held in `role_cards_parity.test.ts` as named skips that cite this
document; a silent pass does not exist anywhere in the suite.

## The seed of record

- Provenance (machine, paths, per-card sha256, capture times):
  `packages/extension/agents/.seed-provenance.json` — the parity suite
  enforces that the repo cards stay byte-identical to these hashes, or that
  any drift carries a recorded, signed amendment.
- Seed machine: **erlich** (the canonical server — the vault-visible machine
  the pin-behind-HEAD check also runs on).
- The diff baseline for each card below is the **engine-neutral definition**
  in the private amicissimo vault's agent records, pinned at amicissimo
  revision `5c6a1cd0d5bd240e07f6bef6467986e2fb41d7a7` (the pin record
  `test/fixtures/vault-agents/pin.json` carries this revision and the
  per-definition digests AT that revision — provenance without content).
- **Review B1 (PR #811) hold:** the full-definition fixtures are NOT
  published in this repo pending the signature — the committed copies failed
  the amended content policy's per-line usage-vs-internals test (the
  engineer definition's src/ module tree, how-to-extend recipe, and
  internals sections; the experimenter definition's literal internal host
  paths; see the two bold fixture flags below). The nightly pin check
  verifies the pin against the vault revision directly, so the hold costs
  nothing in coverage; the fixture publications convert with the signature.

## Overlap map

| Seeded card (opencode binding) | Engine-neutral definition | Verdict |
|---|---|---|
| implementer | `vault/agents/engineer.md` | **OVERLAPS** — the card self-describes as "the Engineer role's binding for the opencode engine" |
| experimenter | `vault/agents/experimenter.md` | **OVERLAPS** (same role name, two eras — see flags) |
| hypothesizer | — | **NO VAULT COUNTERPART** (nearest kin: `researcher.md`, a different role — see notes) |
| analyzer | — | **NO VAULT COUNTERPART** (nearest kin: `librarian.md`, a different role — see notes) |

---

## 1. implementer ↔ `vault/agents/engineer.md` (293 lines @ pin)

### Coherent overlap (unflagged — pinned by the parity suite now)

Both texts carry the same operative semantics on:

- **Delegated TDD leaf** — card: "invoke the **`implement-issue`** skill with
  `--orchestrated`"; vault (develop mode): "delegates to the
  `/implement-issue` leaf… run `/implement-issue {issue} --orchestrated`".
- **Worktree/branch discipline** — card: "Work ONLY on the caller-provided
  worktree branch"; vault: "All changes on branches, never on main", and in
  develop mode "Do NOT `git checkout` a different branch… stay on the
  harness branch".
- **Test protection** — card: "never delete, skip, or mark tests broken to
  force green"; vault: "NEVER delete test files or remove test cases" /
  "Never skip tests or mark them as `@test_broken` to make the suite pass".
- **The structured return contract** — both return the same yaml keys
  (`issue, status, branch, commit_shas, ac_results, notes`); the vault def
  §4a says the Engineer returns "the leaf's structured contract verbatim".
- **Bounded retries, then escalate** — card: "a RED that won't go green after
  its retry cycles is a `failed` return"; vault §5.1: "up to 2 retry cycles…
  report `status: tests-failed`".

### Flagged for signature (divergent — parity pins BLOCK until signed)

Each flag below carries the parity suite's key (`role_cards_parity.test.ts`
pins the skips against these keys verbatim — a flag that leaves this document
breaks the suite, and a pin without a flag here cannot exist).

1. **`implementer ↔ engineer: merge/PR governance` — the sharpest divergence.**
   The seeded card never
   opens PRs, never merges, never pushes ("the walk owns all lifecycle"),
   matching the orchestrated walk and the campaign invariant that merges of
   non-green work are human-only. The vault definition's frontmatter says
   "**Auto-merges when all quality gates pass**" and §3.4 has the engineer
   pushing branches and opening PRs per task (its experiment-mode workflow).
   *Direction per the spec's constraint of record:* repo wins for the
   shipped binding — the vault def's auto-merge line predates the
   orchestrated walk and reads stale against it. Signature should either
   accept the shipped never-merge binding as the coherent one (recommended —
   the vault def then needs a vault-side follow-up edit, out of this slice's
   scope) or amend the card.
2. **`implementer ↔ engineer: scope perimeter`.** The card is one-issue-slice-per-cast, worktree-bound;
   the vault def additionally carries the standalone experiment-mode
   engineering brief (layer skills, multi-package changes, PR lifecycle).
   Same role, two modes of operation; the vault def is the wider contract.
   Not a contradiction — flagging so the signature sees it.
3. **Card-only clauses (no vault counterpart clause):** the `EXHAUSTED:`
   step-exhaustion protocol and the checkout-conflict STOP rule exist only
   in the shipped card. Coherent by addition; nothing to reconcile.

---

## 2. experimenter ↔ `vault/agents/experimenter.md` (624 lines @ pin)

### Coherent overlap (unflagged — pinned now)

- **Brief-driven execution** — card: executes ONE reviewed experiment from
  the briefing; vault: "receive an experiment brief…, write a Julia
  optimization script, execute it… report back".
- **Numbers-grounded reporting** — card: "Debrief with NUMBERS ONLY: what
  ran, the key values"; vault: parses the run's output markers
  (`AMICO_RESULT_*`) and reports them back.

### Flagged for signature (divergent — parity pins BLOCK until signed)

1. **`experimenter ↔ experimenter: self-grading and self-promotion` — the core divergence.** The vault
   definition has the experimenter *grade its own result* ("Determine result
   status by comparing fidelity to the catalog incumbent") and *promote its
   own pulses* ("If the result is a new best: save the pulse to the catalog
   with incremented version"). The seeded card forbids exactly that: "You do
   NOT declare confirm/refute — the parent, the gates, and the analyzer do
   that"; "NEVER grade your own result, and never polish a number". The
   shipped governance is the anti-gaming loop of record (verdicts from gates,
   promotion human-only); the vault def is the pre-loop Phase-2-era contract.
   *Direction:* repo wins for the binding; the vault def is stale on this
   point and should be re-authored vault-side (follow-up, not this slice).
2. **`experimenter ↔ experimenter: environment/checkout discipline`.** The card runs in an assigned
   isolated env per `sessions/CHECKOUTS.md` and refuses silent checkout
   switches; the vault def writes into `amico/scratchpad/{session_id}` with
   no checkout registry. The shipped card is the current fleet reality.
3. **`experimenter ↔ experimenter: artifact contract`.** The card writes raw artifacts + its own
   experiment note with house frontmatter (setup, raw numbers, gotchas,
   honest deviations); the vault def appends TSV rows and saves catalog
   pulses. Different downstream contracts — the analyzer (raw artifacts
   only) depends on the shipped one.
4. **Card-only clauses:** ledger-write prohibition (discipline, not
   permission), the smoke-run-before-long-run rule, the anti-gaming contract
   (CRN pairing, FD sanity gates), and `EXHAUSTED:`. Coherent by addition.

---

## 3. hypothesizer — NO vault counterpart

The amicissimo vault carries no hypothesizer definition. The nearest kin is
`vault/agents/researcher.md` — but the researcher is the **decider** ("the
scientific decision-maker: you decide what to optimize next") who returns ONE
engineering brief, while the seeded hypothesizer is a **read-only proposer**
(ranked hypotheses + spec-card drafts for the director to pick from, and
"ideas are your only product"). Different governance, different output, and
the vault def is itself Claude-Code-era (frontmatter tool lists, model pins).
No pin is possible without inventing a mapping — so the parity suite records
the no-counterpart state explicitly rather than pinning a false overlap.
*For the signature* — suite flag: **`hypothesizer ↔ vault counterpart`**:
confirm no-counterpart (default), or name researcher.md
as the pin target with the governance delta above adjudicated first.

## 4. analyzer — NO vault counterpart

No analyzer definition in the vault. The nearest kin is `librarian.md` — both
"classify failures, extract insights" — but the librarian WRITES curated notes
and catalog entries, while the seeded analyzer is **read-only by permission**,
grounded in RAW artifacts (never the experimenter's transcript), and PROPOSES
ledger verdicts the gates + parent commit. The shipped analyzer's
raw-artifacts-only evidence rule has no vault-side precedent to diff against.
*For the signature* — suite flag: **`analyzer ↔ vault counterpart`**:
confirm no-counterpart (default), or name librarian.md
as the pin target with the write/propose delta adjudicated first.

---

## 5. The fixture publications themselves — held pending signature (review B1)

The two overlapping definitions above were initially committed verbatim as
parity fixtures. The independent review of PR #811 found both committed
copies fail the amended content policy's per-line usage-vs-internals test
(ADR-0011's categories) on a PUBLIC repo, so **both fixture publications are
held pending-signature alongside the flagged content** — removed from the
repo, their parity pins held as named skips in the same gate mechanism, and
nothing from the vault definitions is published-verbatim or pinned before
this signature decides:

1. **`fixture publication: engineer.md (full vault definition)`** — the
   "Important Paths" src/ module tree, the how-to-extend recipe ("follow the
   pattern of `TransmonSystem`…"), the "Complex Internals" architecture
   section, and the roadmap lines ("later Legato", "Legato is a stub") are
   package-internals categories, not usage.
2. **`fixture publication: experimenter.md (full vault definition)`** —
   literal internal host paths (`/home/aaron/harmoniqs/…`) are
   cloud-infrastructure/roadmap-adjacent operational detail, not usage.

**Recommended follow-up for the signature's morning decision (vault-side
work, its own issue + PR under the amicissimo gate — never edited from this
slice):** re-author both definitions at their source in amicissimo — move
the package-internals categories out of the engine-neutral contracts (they
belong in the layer/dev skills' vault-side homes) — then re-take the
fixtures + the pin record at the NEW revision and publish. The nightly
pin-behind-HEAD check guards the interim: it verifies the current pin
against the vault revision directly (no published copy needed) and files a
chore issue on drift.

---

## What the signature authorizes

Signing **accept-seed** (or accept-with-amendments) does two things:

1. The parity suite's pending-signature skips convert to live pins — the
   divergences above are adjudicated as the coherent overlap of record, and
   any card amendment lands with `amended: true` + `amendment_signed_by` in
   `.seed-provenance.json` (the seed-integrity test enforces the record; an
   unsigned tree cannot claim an amendment).
2. The fixture publications decide (section 5): either republish the
   definitions at the pinned revision as-signed, or — recommended — run the
   vault re-authoring follow-up first and re-take fixtures + pin at the new
   revision. Until one of those lands, the fixture halves of the parity pins
   stay held (the pin record stays `pending-signature`).
3. The campaign record (this campaign's ledger §obligations, O2) closes with
   the seed machine's provenance hash and this signature.

Until then: the seeded cards ARE live repo sources (staging, upgrade, and the
doctor treat them exactly like the director cards), machines carrying older
deployed copies read stale until upgraded, and the flagged parity anchors stay
skipped with reasons that cite this file — never silently passed, never
silently pinned.

## Signature

- [ ] **Signed:** ______________  Date: __________
- Decision: `accept-seed` | `accept-with-amendments` (attach amendments)
- Per-card adjudications (only where flagged):
  - implementer ↔ engineer: merge/PR governance — shipped never-merge binding is the coherent overlap? ___
  - implementer ↔ engineer: scope perimeter acknowledged? ___
  - experimenter ↔ experimenter: shipped never-grade/never-promote binding is the coherent overlap? ___
  - hypothesizer: no-counterpart confirmed (or pin target named)? ___
  - analyzer: no-counterpart confirmed (or pin target named)? ___
- Fixture publications (section 5, review B1): republish as-signed, or run
  the vault re-authoring follow-up first and re-take fixtures + pin? ___
