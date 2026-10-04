# The PI report fill contract

The per-loop state-of-campaign report (amicode #1700): a memo-format LaTeX
document the director fills at every research-loop boundary, built with
tectonic. The template lives in `template/pi-report.tex`; this file is the
per-slot rulebook the fill obeys.

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
  no em-dash chains, no narrative flourishes.
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
| **needsyou** | Only the decisions the PI can make (rulings, dispositions, sign-offs, connections, holds). `\emph{none}` when empty. |
| **findings** | One `\finding` per adjudication this loop (final report: the campaign's verdicts). Each explains the hypothesis in plain language, then the numbers (verbatim, legs named) with `\stamp{...}`, then the mechanical meaning. A loop with no adjudications says so explicitly. |
| **digest** | Still-open threads. Bold id + the idea's name + a one-to-two-sentence plain-language statement, then state + last result. Citations welcome. |
| **inflight** | Running casts/solves + expected artifacts. `\emph{none}` when nothing runs. |
| **next** | Top 3 queued items, mechanically cut at 3. |
| **reading** | What was read this loop — external and vault — and what it changed (seeded, sharpened, reframed which thread). When nothing was read, say so explicitly and name the prior reading the loop still rests on. Never silent. |
| **references** | Numbered. External: arXiv IDs traceable to the ledger or a vault card. Vault: existing notes. |
| **footer** | Leave as-is except the fill fields (ledger file, boundary). |

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
