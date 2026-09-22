# 0022 — Retire `dev` as a standing integration branch; supersedes ADR-0021's branch model

Status: accepted (2026-09-16)

ADR-0021 (2026-09-15) established `dev` as a standing integration branch and
`main` as "the trunk Aaron has personally tested," with a fleet canary
downloading `dev`-head's CI artifacts to test against real fleet state
continuously. This record retires that branch structure. The canary *concept*
— continuous testing of a real in-place upgrade on persistent fleet state,
which disposable CI runners cannot exercise by construction — is not
rejected; it is retargeted at `main` directly, where it needs no branch of
its own.

## Why

- **No implementation exists.** The canary's actual mechanism (download a
  blessed SHA's CI artifacts, install on the mini, run a battery, report with
  evidence) was never built. The only landed artifact from ADR-0021 was a
  `ci.yml` trigger change (`push: { branches: [main, dev] }`) — CI runs on
  `dev`, nothing consumes it.
- **`dev` regressed a shipped fix within 48 hours of the ADR.** The wave-2
  back-merge (`dfe3fbe1`, `merge origin/main into dev`) silently dropped the
  #1218 empty-content guard from `provider/transform.ts` during manual
  conflict resolution. Wave-2's `dev → main` merge (#1232) then carried the
  guard-less file back onto `main`, which lost a fix it originally had. CI
  stayed green throughout — `main`'s own `transform.test.ts` asserted the
  guard the whole time, but no CI job runs the overlay's bun test suite. The
  regression was caught by a human manually diffing `dev` against a parallel
  back-merge (#1236), and even that fix only landed on `dev`, not `main`
  (ported separately, #1240). A batching mechanism that loses a shipped fix
  on its first real cycle is a net cost, not a safety net.
- **`dev` was also the GitHub default branch**, not merely a git ref. That
  caused two more concrete failures independent of anything above: PRs
  opened without an explicit `--base` (including #1236 itself, plus #1235 and
  #1226) silently targeted `dev` despite `CONTRIBUTING.md` telling
  contributors to branch from `main`; Dependabot (`.github/dependabot.yml`
  has no `target-branch`) did the same (#577). Separately, PR #1196/#1199
  reworked `build:app`'s `#992` deploy-safety guard to resolve "canonical
  trunk" as the live default branch rather than the literal string `main` —
  which meant the shipped deploy doctrine was silently checking HEAD against
  `dev`, not `main`, the moment the default branch flipped.
- **The batching value `dev` was meant to provide doesn't need a permanent
  branch.** Wave-2's actual divergence from `main` peaked at 18 commits over
  about a day and a half — an ephemeral `integration/wave-N` branch, created
  for that batch and deleted on merge, gets identical soak-testing (CI runs
  on `pull_request` regardless of base) without a ref that outlives every
  wave and immediately reaccumulates drift against long-lived feature
  branches.
- **CI already runs on every `main` commit and every PR**, and already
  builds real cross-platform binaries and boot-smokes them
  (`build-binary`, `boot-smoke` × 3 platforms, `vsix-gate`,
  `app-shelf-boot-proof`). An `-alpha.N` tag on any `main` push already
  produces an installable artifact. Neither of these needed `dev` to exist,
  and both continue unchanged.

## What actually changes

- GitHub's default branch: `dev` → `main` (done).
- The three PRs that had silently targeted `dev` retargeted to `main`
  (`#1235`, `#1226`, `#577`; done).
- `ci.yml`: drop `dev` from the push trigger (this change).
- `docs/adr/0021-canary-fleet-arms-ci-artifacts.md`: amended in place to note
  it's superseded here (this change).
- `origin/dev` deleted once the above land and its one outstanding commit
  (the #1236 guard restoration) has an independent path onto `main` (#1240).

## What is *not* rejected

The canary's structural insight is correct and worth keeping: CI's disposable,
fresh-checkout runners cannot exercise an in-place upgrade of a real,
persistently-running machine with accumulated state (an existing install,
a real session DB, real config, real network topology) — that's exactly the
class of bug ("entitlement-code drift, guard drift, projection clobbering")
ADR-0021 was responding to, and it's real. A future canary should:

- poll `main`'s own CI-green commits (or its `-alpha.N` tags) for a blessed
  SHA — `main` has produced one on every push all along, no branch needed;
  fetch artifacts, never build its own (ADR-0021's invariant stands);
- run on the mini, never the daily driver (ADR-0021's isolation call stands);
- drive the real upgrade path — which first needs the `lsof`/`set -e -o
  pipefail` bug in `scripts/rebuild_amicode.sh` fixed (a non-fatal `lsof`
  exit status currently kills the script before any build step runs whenever
  another process holds the session DB open, which is always, in practice);
- file findings to the board with evidence and never work the board itself
  (ADR-0021's other good principle, also kept).

## Considered options

- **Keep `dev`, build the canary for real.** Rejected: doesn't fix the
  default-branch misconfiguration or the demonstrated back-merge data loss,
  and the canary doesn't need the branch to exist regardless.
- **Keep `dev` as a documentation-only concept, unused.** Rejected: it's
  still the thing PRs and Dependabot silently target by default; leaving it
  in place leaves the failure mode live.
- **Ephemeral per-wave integration branches, created and deleted per batch.**
  This is the model going forward when a wave genuinely needs joint
  soak-testing before `main` — not rejected, just not a standing branch.
