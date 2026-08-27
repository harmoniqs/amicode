# Contributing to Amicode

Welcome! Amicode is an open-core **quantum optimal-control copilot** built by
[Harmoniqs](https://github.com/harmoniqs). The VS Code extension and its
platform skills — transmon, Rydberg atoms, fluxonium, bosonic cavities,
trapped ions — are Apache 2.0–licensed and open for contributions. Proprietary
solver backends (Piccolissimo, Altissimo) remain behind an entitlement gate,
but everything else is yours to hack on.

## Table of Contents

- [Development Gate](#development-gate)
- [Repo Structure](#repo-structure)
- [Dev Setup](#dev-setup)
- [How to Add a Platform Skill](#how-to-add-a-platform-skill)
- [Testing](#testing)
- [CI / CD](#ci--cd)
- [Submitting a PR](#submitting-a-pr)
- [Getting Help](#getting-help)

---

## Development Gate

**Every code change to a Harmoniqs repo needs a GitHub issue and a pull
request.** This is not bureaucracy — it is how the team tracks what is being
worked on and why, and it ensures your contribution gets reviewed.

- **Found a bug?** Open a [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) first.
- **Want a feature?** Open a [feature request](.github/ISSUE_TEMPLATE/feature_request.yml) first.
- **Small fix?** Same rule — create an issue. The issue *is* the record.

Your PR title must reference the issue number (`Closes #<N>`). Unsolicited
PRs without an issue will be asked to create one first — it saves wasted
work if the approach already has a decision.

---

## Repo Structure

```
amicode/
├── packages/
│   ├── amico-run/    -- The `amico` / `amico-run` CLI
│   ├── extension/    -- The VS Code extension (the product users install)
│   └── schema/       -- Shared JSON schemas + cross-language validation (TS + Julia)
├── tools/
│   └── trace-export/ -- OpenTelemetry trace export pipeline (Python)
├── docs/
│   ├── adr/          -- Architecture Decision Records
│   ├── getting-started.md
│   └── features.md
├── .github/
│   ├── workflows/    -- CI (ci.yml), promotion (promote.yml), release (release.yml)
│   └── ISSUE_TEMPLATE/
├── AGENTS.md         -- Full development guide for agent-based contributors
├── CLAUDE.md         -- Agent entry point (points to AGENTS.md)
├── CONTEXT.md        -- Domain-language glossary
└── package.json      -- pnpm workspace root
```

Three packages, one workspace. `packages/schema` is the cross-language
contract — TS types (`ajv`) and Julia validation (`JSONSchema.jl`)
must agree.

---

## Dev Setup

**Prerequisites:** Node ≥ 20, Julia ≥ 1.12 (via `juliaup`), `corepack enable`.

```bash
git clone git@github.com:harmoniqs/amicode.git
cd amicode
corepack enable && pnpm install
pnpm -r build

# Fetch the vendored opencode binary (for chat + Run Inspector)
pnpm --filter amicode run fetch:opencode

# Run the fast test suite
pnpm -r test

# Install the extension + Julia env + lab config
bash packages/extension/scripts/install.sh
node packages/extension/scripts/healthcheck.mjs
```

The full agent-oriented setup guide lives in [`AGENTS.md`](AGENTS.md) at the
repo root. That file covers environment checks, private-fork access, and
debugging steps in detail.

**Extension development** uses the standard VS Code F5 launch flow:
`.vscode/launch.json` runs the `extension` package in debug mode. Hot-reload
the webview by reloading the window.

---

## How to Add a Platform Skill

Platform skills (transmon, Rydberg, fluxonium, etc.) are shipped as **data**
under `packages/extension/scores/`. Each skill is a self-contained score
directory with:

- `SCORE.md` — the interview flow and physics reference
- `templates/` — Julia problem templates and skeletons
- `memory/` — guidance cards (confidence rubric, regime guidance, etc.)

To add a new platform:

1. Create a score directory under `scores/` following the existing structure.
2. Register the score in the pulse-designer dispatch in `scores/pulse-designer/`.
3. Add the platform-specific Hamiltonian and system constructor to the template.
4. Wire it into the `amico-run resolve` tier-resolution logic in
   `packages/amico-run/src/`.

The best template to copy is an existing complete score — `scores/pulse-designer/`
is the canonical interview, and `scores/pulse-designer/templates/` holds the
vetted solve scripts.

---

## Testing

| Tier | Command | Scope |
|---|---|---|
| **Fast** | `pnpm -r test` | All unit tests across all packages (excludes `**/slow/**`) |
| **Slow** | `pnpm --filter amico-run test:slow` | Julia E2E (requires `AMICO_TEST_JULIA_PROJECT`) |
| **Smoke** | `pnpm --filter amicode test:smoke` | Boot smoke: extension loads, opencode binary is healthy |
| **Packaging** | `AMICODE_REQUIRE_VSIX=1 pnpm --filter amicode test` | Asserts every expected file exists in the built `.vsix` |
| **Schema** | `cd packages/schema/julia && julia runtests.jl` | Cross-language schema conformance (TS ↔ Julia) |

All fast tests must pass before a PR is marked ready. CI enforces this —
see [CI / CD](#ci--cd).

### Writing Tests

The project uses **Vitest**. New code must include tests. For a bug fix,
write a test that reproduces the bug before implementing the fix. For a new
feature, write tests for the public API surface, not internal details.

Extensions to existing test files are preferred over creating new ones
(reuse-first). If the existing test surface does not cover your change,
create a new file alongside the module it tests.

---

## CI / CD

The CI pipeline runs on every push and PR:

1. **ci.yml** — builds all packages, typechecks, runs fast tests, runs the
   CLI behavioral gate (every declared binary accepts the remote executor),
   and validates shipped configs against the schema.
2. **schema-roundtrip** — Julia-side schema tests: golden fixtures, producer
   round-trips, anti-drift (a schema perturbation flips both TS and Julia),
   vendoring-drift checks against pinned Piccolo/Piccolissimo sources.
3. **vsix-gate** — builds the real `.vsix`, runs the UI gate (vendored
   opencode has the amicode surfaces enabled), runs packaging manifest tests,
   uploads the artifact.
4. **boot-smoke** — cross-platform boot smoke on ubuntu, arm64 ubuntu, and
   macOS.

Releases are manual: the _Promote_ workflow cuts a clean tag from an alpha,
then the _Release_ workflow builds 7 `.vsix` files (4 installable + 3
cover packages with no vendored binary), creates a GitHub Release, and
publishes to the VS Code Marketplace.

---

## Submitting a PR

1. Ensure an issue exists that describes the change.
2. Branch from `main` — name conventions are flexible; the issue number in
   the branch name helps (e.g. `303-contributing-docs`).
3. Make your changes. Keep commits focused and messages descriptive.
4. Run the fast test suite: `pnpm -r test` (and `pnpm -r run typecheck`).
5. Open a **draft** PR at the first commit with `Closes #<N>` in the body.
   This signals work in progress and triggers CI early.
6. When the full suite is green and the code is ready, mark the PR ready
   for review.
7. A maintainer reviews and merges.

The PR template includes a checklist — fill it out to speed up the review.

---

## Getting Help

- **Questions and discussion** — use [GitHub Discussions](https://github.com/harmoniqs/amicode/discussions).
  This is the right place for "how do I…" or "what's the best way to…".
- **Bug reports and feature requests** — use the issue templates linked above.
- **Internal development notes** — the team's design authority lives in the
  Harmoniqs vault; external contributors work from the public `AGENTS.md` and
  `CONTEXT.md` in this repo.

Pull requests and issues are monitored. We aim to acknowledge contributions
within one week.
