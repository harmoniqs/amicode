---
type: session
date: 2026-08-20
label: "hrl-8dot-spin-mintime"
status: active
tags: [session, autoresearch, spin-qubit, hrl, silicon, min-time, calibration, exchange]
---

# Session ledger — HRL 8-dot spin: minimum-time gates + calibration

## 1. Objective & standing directives

- **Objective**: autoresearch campaign on a model of the **HRL 8-dot silicon spin chip**
  (linear Si/SiGe quantum-dot array): **minimum-time gates** — CZ via exchange first
  (validated demo family), then the interesting extensions on the 8-dot geometry
  (spectator-dot crosstalk, CNOT via exchange+EDSR, possibly EDSR single-qubit) — and
  **closed-loop calibration of the min-time pulses** under quasi-static charge noise /
  parameter drift (QILC-style, simulated — no device I/O is wired in this build).

## 2. Hypothesis ledger

| H# | hypothesis | verdict | evidence |
|---|---|---|---|
| H2 | Min-time compression charges a robustness tax under quasi-static charge noise (≥ 0.5 pp at σ_δ = 0.05δ, σ_J/J = 5%); adjoint buys back at most half | **REFUTED (inverted)** — σ_survive = NONE for all 4 pulses (F_mean < 0.99 at every σ ≥ 0.005 — the cliff is below the grid); at every σ the compressed pulses are ≥ the nominal (S4 inversion CONFIRMED at M=50, all six σ, both cells). The tax premise is dead in this family; the striking finding is absolute fragility: uncalibrated F_mean ≈ 0.73-0.75 even at 0.5% drift | calib/sweep/*.toml + note |

## 3. Active work

- **Experimenter cast COMPLETE (EXHAUSTED, budget 10/10)** — task
  `ses_fdf5215daffePV0XPMM97O8XQC` (three segment-returns, truncated twice; work products
  audited from disk each time).

## 4. Blocked & reasons

- **Cloud lane DOWN** — amicode #423: `harmoniqsapis.com` NXDOMAIN (verified live this
  session, day 3+). NO LONGER BLOCKS H1 (fleet routing chosen at the launch gate) but
  still blocks any cloud-shaped work and the parked cat-cavity campaign. Human lever:
  registrar/DNS fix.

## 5. Next queue

1. **Altissimo CPU bring-up on erlich (user directive, 2026-08-26)**: patch
   Piccolissimo worktree (one-line n_ineq fix, §7) → 0-unit smoke on the P2B ensemble
   problem → P2B contingency re-solve Altissimo-primary (1 committed unit). This also
   discriminates optimizer-limited vs formulation-limited on HV (§2).

## 8. Loop log

| date | H# | spec_id | review | experimenter | gates | notes |
|---|---|---|---|---|---|---|
| 2026-08-20 | — | — | — | — | — | Kickoff: probes (vault mounts, catalog — no spin incumbents; STRATEGY P11 adjacent; cloud lane NXDOMAIN verified live; `cx-gate-spin` prior failure read). Ledger created; hypothesizer cast. |
| 2026-08-20 | H1 | spec-20260820-hrl-spin-cz-mintime-scaling | approved-mechanical ×2 (fleet-routed amendment, design hash 2765bace433844d2…) | EXPERIMENTER cast in flight | none yet (no compute spent) | Launch gate: user chose fleet-CPU routing (erlich, Altissimo primary) + demo-family params. Spec amended + re-approved. CHECKOUTS row claimed. Mechanism: SSH dispatch, not amico-run (recorded in spec LAUNCH MECHANISM invariant). |

## 9. Compaction log

*(append-only: timestamp, auto/manual, messages dropped, summary audit result)*
| 2026-08-20 | H1 | spec-20260820 pass-3 amendment (approved-mechanical, 0 findings) | same | EXPERIMENTER pass 3 COMPLETE (ses_fdf5215daffePV0XQC, 12/12 budget) | parent gates: 5/5 lower-edge probes rollout-verified (max \|Δ\| 1.8e-6 at B@70); pass3_summary.toml verified; note PASS 3 section grep-verified present (experimenter honest this round) | H1 DECIDED (three-way split, §2). Sub-20-ns CZ is the campaign's first bankable result (banking = human-only). Analyzer skipped again (pass/fail structure; parent gates sufficient). Loop pivots to H4/H2 per §5. |
| 2026-08-20 | H4′+H2′ | spec-20260820-hrl-spin-cz-fast-calibration | mechanical clean + MANUAL CRITIC (BLOCK → 3 blockings discharged → approved; one session/three lenses, deviation recorded) | EXPERIMENTER cast in flight (ses_fdf5215daffePV0XQC) | none yet | Experiment 2: calibration of the fast CZ. Budget 22. Standing authorization active. |
