---
type: session-ledger
schema_version: "1"
campaign: strumento-twins-bringup
date: 2026-08-30
status: ACTIVE
previous: session-20260829-calibration-stack-codesign.md (parallel, ACTIVE)
tags: [session, autodev, strumento-jl, twins, bringup, intonato, sosia, spira]
---

# Ledger — Strumento.jl twins + bring-up substrate

## 1. Objective & standing directives

- Execute the 2026-08-30 plan-of-record (user-approved across the plan-mode session):
  make **Strumento.jl the substrate** — soc registry (real/mock/twin), digital twins,
  device bring-up — while **execution stays on Python strumento + QICK, untouched**.
- Division of labor (user, load-bearing): **Strumento.jl calibrates the device;
  Intonato/issimo calibrates the pulse given the device.** Python strumento executes
  both on hardware. Julia procedures drive Python experiments through the seam; the
  twin serves the same D14 wire so rehearsal = production with a registry-id change.

## 2. Verdict table (slices)

| slice | repo | content | status |
|---|---|---|---|
| S1 | Strumento.jl #14 | Drop the Intonato dependency — standalone substrate: Piccolo direct dep, MockSoc rollout refactor (drop Intonato's SimulatedExperiment), delete backend.jl/experiment.jl/integration_test.jl (relocated by S2), exports pruned, v0.2.0, register in General | **DONE** — PR #17 squash-merged @ 3e94ae4 (director suite re-run 31/31; CI green 10m17s); v0.2.0 registration posted (commitcomment-198283928) — General PR pending |
| S2 | Intonato.jl #31 | Absorb the seam: StrumentoBackend + StrumentoExperiment + integration tests move in, dep Strumento ≥ 0.2, `using Intonato` reexports the full stack; fold the stale IntonatoQICK docstring fix | **IN FLIGHT** — unblocked (v0.2.0 REGISTERED, General#166615 merged 2026-08-31T00:27Z); cast L7-impl-31, worktree /tmp/wt-intonato-s2 @ `31-absorb-seam` |

## 3. Active work — cast receipts

| cast | role | target | result |
|---|---|---|---|
| L1-impl-14 | implementer | Strumento.jl #14, /tmp/wt-strumj-s1 @ `14-standalone-substrate` | **DONE** — 2 commits (88c9d6f golden pin first, 5e34a3f inversion); golden values held bit-exact (no tolerance widened); director re-ran suite 31/31 + hermetic Intonato-free load; PR #17 CI green → squash-merged @ 3e94ae4; #14 auto-closed |

## 4. Blocked & reasons

- **S2** blocked by S1 merged AND Strumento v0.2.0 through General auto-merge
  (Intonato CI must resolve the dep; JuliaRegistrator → General PR → auto-merge is
  hours of latency — the watch item).

## 5. Next queue

1. ~~File S1–S5 issues~~ — **DONE**: Strumento.jl #14/#15/#16, Intonato.jl #31, spira #2 (afk-labeled; afk/hitl created where missing).
2. S1 (#14) + S5 (spira #2) casts **IN FLIGHT** (parallel, disjoint repos).

## 6. Checkout topology

- Mirrored in `sessions/CHECKOUTS.md`; claim rows added at dispatch.

## 7. Gotchas & methodology

- **Julia using-scope shadowing** (Strumento.jl #12 find): a method defined on a
  `using`-imported name mints a fresh local function — contract functions must be
  explicitly `import`ed. The seam move (S2) MUST carry the function-object identity
  test to its new home.

## 8. Loop log

| loop | date | unit | verdict | artifacts |
|---|---|---|---|---|
| 0 | 2026-08-30 | kickoff: director-core bound, dev gate pack read, parallel ledgers read (calibration-stack-codesign ACTIVE, Brad freeze noted), repo+registry recon done, plan-of-record confirmed against disk state | ledger created | this file |
| 1 | 2026-08-30 | decompose: issues #14/#31/#15/#16/spira#2 filed via write-an-issue (the plan-approved set), labels ensured, worktrees /tmp/wt-strumj-s1 + /tmp/wt-spira-s5 cut from main, CHECKOUTS claimed; dispatching S1 ∥ S5 in parallel | **DONE** — both slices merged: Strumento PR #17 @ 3e94ae4 (director-gated: suite re-run 31/31, hermetic load check, CI green), spira PR #3 @ 6d39ce7 (director note-read gate); v0.2.0 registration posted | issues, PRs #17/#3, this file |

## 9. Compaction log

- (none — append one row per compaction; re-read this file first)
