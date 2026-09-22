# 0021 — The canary runs on always-on fleet arms, from CI's own artifacts — never on the daily driver

Status: superseded (2026-09-16, see [ADR-0022](0022-retire-dev-branch.md)) — the
`dev`/`main` branch model this record assumed is retired: `dev` regressed a
shipped fix within 48 hours of this ADR (the wave-2 back-merge dropped the
#1218 guard, silently, CI-green throughout) and was also the GitHub default
branch, which caused PRs and Dependabot to silently target it instead of
`main`. No canary implementation was ever built against it. The canary
*concept* below — real fleet-state testing of an in-place upgrade, which CI's
disposable runners cannot do — is kept and retargeted at `main` directly, per
ADR-0022. The branch-specific details below (dev as integration branch, "the
canary blesses the integration tip") are historical.

With `dev` as the integration branch and `main` as the trunk Aaron has personally tested (2026-09-15), the mechanical pre-test of dev must happen continuously and on *real fleet state* — the thing CI's clean runners are structurally blind to (the 2026-09-15 session found three failure classes in one day, every one CI-green: entitlement-code drift, guard drift, projection clobbering). We decided the Canary is a fleet service: its orchestrator and server arm run on the hub, its client arm installs the prebuilt universal VSIX (darwin binary embedded) on the mini, and **Aaron's macbook is excluded by policy** — continuous machinery never mutates the daily driver (the week's three clobber mechanisms were all surprise-automation on that machine). The canary **downloads the dev-head's CI artifacts and never builds anything itself** — the invariant *canary = CI-green + real-fleet-state* — because a second build pipeline is exactly the drift class the fork absorption campaign retired.

## Considered Options

- **Canary on the macbook (install included)** — rejected: collapses Aaron's test step the furthest, but nightly installs on the daily driver are the surprise-automation class that bit this fleet three separate ways in one week; his visual acceptance stays a deliberate, human, wave-time act.
- **Hub-local artifact builds** — rejected: independent of CI artifact retention, but a second build path that can silently diverge from CI's; the canary would then test *its own* artifacts, not the ones anyone ships.
- **The mini as a full build arm** — rejected: the mini is severely memory-limited; it installs prebuilt artifacts and runs a light battery only.

## Consequences

- The mini becomes the standing **dev station** — same platform build and fleet-client role as the macbook, so a visual check there is representative; its known tunnel flapping surfaces as the canary's first finding rather than staying a mystery.
- The staging slot (own port, own data dir) becomes the only sanctioned way to boot-test server bits on the live hub — the live service is never touched by testing machinery (self-surgery doctrine).
- Canary findings are filed to the board with evidence; the canary never works the board — triage and fixes belong to the standing queue and the human.
