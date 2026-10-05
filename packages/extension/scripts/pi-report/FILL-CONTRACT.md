# The research loop report fill contract

The per-loop state-of-campaign report (amicode #1700, format v2 #1718): a
memo-format LaTeX document the director fills at every research-loop
boundary, built with tectonic. The template lives in `template/pi-report.tex`;
this file is the per-slot rulebook the fill obeys.

## The register — a letter to the researcher who owns the campaign

The report speaks directly to the researcher, in their own campaign's
vocabulary: findings explain what was asked and what the numbers say;
"needs you" lists the decisions only the owner can make. No role labels, no
committee voice, no "as your PI" — the researcher-is-the-PI posture stays
implicit. String checks pin what strings can verify (the rendered text and
the sources carry no role branding); tone beyond that is **review-carried**,
stated here rather than pretended gate-carried.

## The doctrine, and what replaced it

The amicissimo origin spec (#356 M3) demanded a **pure mechanical
projection** — no agent-authored prose anywhere. Issue #1700 deliberately
**supersedes that**: the agent fills the template. The replacement
guardrails, all mechanical, keep the report honest:

1. **Verbatim numbers.** Every number in a finding is copied from the
   ledger. The gate checks number-bearing strings against the ledger.
2. **Provenance stamps.** Every number rides with its artifact path or
   ledger row, via `\stamp{...}`. A number that cannot name its source
   does not go in the report.
3. **Traceable citations.** Every external reference's arXiv ID must
   appear in the ledger or a vault card; every cited vault note must
   exist. Untraceable references fail the gate.
4. **The gate.** tectonic build + slot presence + the provenance/citation
   lints. There is **no page cap** (see below).

What the agent *may* do: explain, order, cite, decide which threads earn
a digest line. What it may *not* do: soften a verdict, merge legs, drop a
legs-named pair into one flattering figure, round a number, or invent a
state or a citation.

## Writing rules

The report is a memo to the PI, not a dashboard and not a summary. Two
earlier shapes failed review for opposite sins — round 1 was compressed
ledger prose (unreadable walls), round 2 was telegraphese (no
understanding). The rules that fix both:

- **Explain before you state.** A reader who does not know what H9 is must
  understand it from the report. Every finding opens with what the
  hypothesis was, in plain language; every digest thread names the idea
  before its state. Never an unexplained H-number.
- **Prose findings, not table rows.** Each adjudication is a `\finding`:
  what was asked, what ran, what the numbers say (legs named), what it
  means mechanically. Short declarative sentences; one fact per sentence;
  no em-dash chains, no narrative flourishes. The register is direct
  address — the report reads as a letter to the researcher who owns the
  campaign, never as a memo to a role.
- **Numbers in context.** 0.5033 alone is noise; 0.5033 at a −1%
  atom-spacing error, against the 0.98 bar, with the mechanism measured to
  2×10⁻³ — is a finding. Scale anchors welcome (analytic limits, prior
  results).
- **Citations are first-class.** Numbered references, cited inline
  `[ref.~[n]]`. External literature from the ledger's lit rows; vault
  pointers (insight cards, experiment notes) count as references.

## Slots

Every `%% SLOT:` marker stays in the filled copy — the gate greps them.

| Slot | Rule |
| --- | --- |
| **header** | Campaign, posture, boundary (loop #, or "closed" for a final report), date, ledger filename. |
| **summary** | Verdict counts from the hypothesis table, **counted** in the ledger's own vocabulary. Then one sentence of campaign state. |
| **needsyou** | Only the decisions you can make (rulings, dispositions, sign-offs, connections, holds). `\emph{none}` when empty. |
| **findings** | One `\finding` per adjudication this loop (final report: the campaign's verdicts). Each explains the hypothesis in plain language, then the numbers (verbatim, legs named) with `\stamp{...}`, then the mechanical meaning. A loop with no adjudications says so explicitly. |
| **digest** | Still-open threads. Bold id + the idea's name + a one-to-two-sentence plain-language statement, then state + last result. Citations welcome. |
| **inflight** | Running casts/solves + expected artifacts. `\emph{none}` when nothing runs. |
| **next** | Top 3 queued items, mechanically cut at 3. |
| **reading** | What was read this loop — external and vault — and what it changed (seeded, sharpened, reframed which thread). When nothing was read, say so explicitly and name the prior reading the loop still rests on. Never silent. |
| **references** | Numbered. External: arXiv IDs traceable to the ledger or a vault card. Vault: existing notes. |
| **footer** | Leave as-is except the fill fields (ledger file, boundary). |

## The formulation record (the user stays in the loop)

A problem statement is **derived from the run, never recalled by the agent**.
Every solve emits `formulation.toml` into the run dir — for spec-built
problems, the retained `ProblemSpec` (`extract_spec`, verified against the
object upstream); for hand-built problems, the upstream best-effort
extraction (`canonical = false`) plus a `solver_actuals` block from the
call site (the declarative `[solver]` never enters the problem, so the
actuals must come from the `solve!` call).

- **The classic-form block is generated from the record** —
  `render_formulation.py` turns `formulation.toml` into the LaTeX block
  per the `formulation-display` skill's forms. Zero agent invention in
  the math; the agent writes the explanation *around* it.
- **The gate checks component references**: every integrator, objective
  term, constraint, weight, or bound the prose names must appear in the
  run's record (`stated_components`). A stated component absent from the
  record is a red receipt; a finding with no record behind it is marked
  **UNBACKED**.
- **Corrections target the source** (the spec or the script), then
  re-render. A formulation correction made in the rendered prose is lost
  on the next render — the contract forbids it.
- Raw inline matrices in best-effort records are capped to digest + dims
  in renders (full matrices live in the spec/script source; run dirs
  sync across machines).

## Honesty bars (inherited from the display conventions)

- Legs are named: `F_gate 0.9929 / F_mod 0.9884` — never one flattering figure.
- The researcher's notation: infidelity as `2.1e-4`, fidelity as
  `F = 0.9982`, the way the ledger writes it.
- Verdicts ride verbatim: "FALSIFIER A FIRED", "OPEN-AT-BUDGET",
  "UNADJUDICATED-FOR-BRANCH" stay exactly as the ledger states them.
- A stale report is visibly stale — the stale-marker pattern carries over
  from the superseded amicissimo implementation.
- The report never writes back: read-only projection of the ledger.

## Length: no cap, a receipt

A quiet loop renders one page; a rich loop runs three. The page count is
recorded in the render receipt as a signal, never enforced as a gate —
forcing rich loops into a fixed cap is what produced the unreadable early
fills. If a report runs past ~4 pages, the receipt flags it for the
director to consider splitting (loop report + separate deep-dive), but the
build never truncates, demotes silently, or blocks the loop.

## The figures layer (v2, #1718)

Findings **embed their evidence** — the report is self-contained because
run-dir paths don't open across machines (amicode #1653). Figures render at
the record boundary from what the run actually saved, through ONE entry
point (`render_figures.py`), and land in a per-report `figures/` directory
beside the `.tex` (the synced vault package stays self-contained; the
directory doubles as the provenance audit surface).

- **Per-finding display sets**, keyed by the finding's recorded problem tier
  (unresolvable tier → the control set + a receipt flag). Control problems:
  the final pulse (knots + bounds) and one results figure the finding
  adjudicates on. Calibration findings: the required set, pinned verbatim —
  measurement model, per-iteration pulse + correction, convergence with
  accepted/rejected Armijo steps.
- **Provenance is correspondence, not a stamp string**: every figure carries
  the artifact it rendered from, the run-id and loop it served, and the
  render timestamp; the manifest (`figures/figures.json`) records the
  artifact→figure pair, and a figure from another run or loop is detectable
  by the gate, not by trust.
- **Captions carry the verdict numbers with their stamps** — the
  caption↔figure↔number triangle: a figure whose caption carries no stamped
  number is decorative, and decorative figures don't ship.
- **Failure semantics are receipts-not-gates**: a missing or unreadable
  artifact, a failed plot script, or a render timeout degrades to a
  `\figurereceipt` (FIGURE UNAVAILABLE) line naming the artifact and
  reason. The numbers and stamps stay, the report ships, the build never
  blocks, nothing is placeholder-substituted.
- **Legibility bars**: ≤4 figures per finding (the calibration set's own
  size — a smaller cap pressures set-splitting); a total-figures backstop
  per report rides the receipt; over-cap is a receipt flag, never a
  truncation.
- **In-flight work names expected artifacts** (run-id + filename —
  resolvable on the server, greppable in the ledger); it never embeds and
  never links. Their cross-machine unactionability is acknowledged, not
  hidden.

## Build & gate

```
tectonic <filled>.tex
```

Gate checks (in order): build succeeds; every `%% SLOT:` marker present;
number-bearing strings in findings appear in the source ledger; every
arXiv ID appears in the ledger or a vault card; cited vault notes exist.
Any failure is a receipt line, exit 0 — the loop never waits on the
report.

## Where filled reports live

Real campaign fills are **never committed to this repo** (it is public;
campaign data is not). Their durable home is the **personal vault's
`amicode/pi-reports/`** — the git-synced vault carries every render to
every fleet machine, where VS Code opens the PDF directly. That is the
cross-machine review path: no fleet-session file links (they don't open
across machines, amicode#1653) — the artifact syncs to the reader, the
reader never fetches from the session host.

Render loop: fill from the ledger → tectonic → `.pdf` + `.tex` land in
`amicode/pi-reports/<campaign>-<boundary>.{pdf,tex}` → vault sync →
review on any device. Committed fixtures in this repo stay synthetic
(`fixtures/`), shaped like the two real ledger formats.
