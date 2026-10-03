# The PI report fill contract

The per-loop state-of-campaign report (amicode #1700): a 1–2 page LaTeX
document the director fills at every research-loop boundary, built with
tectonic, gated mechanically. The template lives in `template/pi-report.tex`;
this file is the per-slot rulebook the fill obeys.

## The doctrine, and what replaced it

The amicissimo origin spec (#356 M3) demanded a **pure mechanical
projection** — no agent-authored prose anywhere. Issue #1700 deliberately
**supersedes that**: the agent fills the template. The replacement
guardrails, all three mechanical, are what keep the report honest:

1. **Verbatim verdicts + numbers.** Every verdict string and every number
   in an adjudication row is copied from the ledger. The gate checks
   number-bearing strings against the ledger (see `build_report.py`).
2. **Provenance stamps.** Every number rides with its artifact path or
   ledger row, via `\stamp{...}`. A number that cannot name its source
   does not go in the report.
3. **The gate.** tectonic build + 1–2 page cap + slot presence + the
   provenance lint. Over-cap is a red with the demotion ladder below —
   never a silent truncation.

What the agent *may* do: compress prose (one-line hypotheses, one-line
thread states), order rows, decide which threads earn a digest line.
What it may *not* do: soften a verdict, merge legs, drop a legs-named
pair into one flattering figure, round a number, or invent a state.

## Style (the anti-slop rules)

The report reads like a lab notebook, not a summary. Round 1 of the real
fills failed review for reading "like slop" — dense em-dash-chained walls of
compressed ledger prose. The cure is mechanical:

- **Short declarative sentences.** Period-separated. One fact per sentence.
  No em-dash chains, no parenthetical nestings, no narrative connective
  tissue ("the campaign's payoff landed" is banned; "First rydberg pulse
  promoted" is the register).
- **Numbers lead.** Each adjudication row opens with the measured result,
  then one clause of mechanism at most. The ledger keeps the story.
- **Rows are 2–3 lines.** A row that wants 5+ lines is two facts — split
  it or cut one.
- **No restating hypotheses in full.** The id + one line of state; the
  ledger carries the spec.

## Slots

Every `%% SLOT:` marker stays in the filled copy — the gate greps them.

| Slot | Rule |
| --- | --- |
| **header** | Campaign, posture, boundary (loop #, or "closed" for a final report), date, ledger filename. The ledger file is the report's source of record. |
| **summary** | Verdict counts from the hypothesis table, **counted** — grouped in the ledger's own vocabulary (supported, falsified, open, queued...). Then one sentence of campaign state. Counts are generated: count the table, never estimate. |
| **adjudications** | Rows adjudicated **this loop** (a final report: the campaign's verdict table). Columns: id, verdict verbatim, outcome. The outcome line: one-line hypothesis + the headline number(s) with legs named (`F_emu` / `F_mod`, never one figure), + `\stamp{provenance}` last. |
| **digest** | One line per still-open thread: id + one-line state + the last result that keeps it open. A thread that is neither live nor next does not appear. Over-cap: collapse to a counts line ("N open: a supported-at-budget, b open, ..."), never drop rows silently. |
| **inflight** | Running casts/solves, one line each, with expected artifacts. Nothing running: a single `\emph{none}` line. |
| **needsyou** | Only the decisions the PI can make (rulings, dispositions, sign-offs, connections, holds). `\emph{none}` when empty — never invented urgency. |
| **next** | The top 3 queued items, mechanically cut at 3. Each names the work in one line. |
| **footer** | Leave as-is except the fill fields (ledger file, boundary). |

## Honesty bars (inherited from the display conventions)

- Legs are named: `F_gate 0.9929 / F_mod 0.9884` — never "F ≈ 0.99".
- The researcher's notation: infidelity as `2.1e-4`, fidelity as
  `F = 0.9982`, the way the ledger writes it.
- Verdicts ride verbatim: "FALSIFIER A FIRED", "OPEN-AT-BUDGET",
  "UNADJUDICATED-FOR-BRANCH" stay exactly as the ledger states them.
- A stale report is visibly stale — the state file's stale-marker pattern
  carries over from the superseded amicissimo implementation.
- The report never writes back: it is a read-only projection of the
  ledger; no ledger, board, or catalog writes.

## Build & gate

```
tectonic <filled>.tex          # build; 1–2 page cap asserted after
```

Over-cap demotion ladder (apply in order, re-render, re-check):
1. digest rows → a counts line
2. in-flight/needs-you lines beyond 5 → the top 5 with a "+N more" line
3. next → top 2, then top 1

If the demoted report is *still* over cap, the fill failed — the loop
records the degradation receipt (markdown projection + queue line) and
moves on. The loop never waits on the report.

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
