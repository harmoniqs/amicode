# Amicode — agent setup & testing guide

You are (probably) an agent asked to set up, develop, or test Amicode on this machine.
This file is the canonical path. The human-oriented test script is
`packages/extension/TESTING.md`; design authority lives in the `harmoniqs/amico` vault
(see `README.md`). **Do not confuse this file with `packages/extension/AGENTS.md`** —
that one is the product's runtime instruction set for the in-app agent, not for you.

## What this is

A VS Code extension (`packages/extension`, pnpm workspace) for conversational quantum
pulse design: chat (an opencode server we vendor, branded as Amicode) → guided interview
→ LLM-authored Julia solve (Piccolo) via `packages/amico-run` → live Run Inspector.
Interview flows are data (`packages/extension/scores/`). Schemas: `packages/schema`.

## Prerequisites (verify each; do not assume)

1. `node >= 20`, `corepack enable` (repo pins `pnpm@9.15.9` — never install pnpm globally)
2. Julia ≥ 1.12 via juliaup: `curl -fsSL https://install.julialang.org | sh`
3. `gh auth status` succeeds AND `gh repo view harmoniqs/opencode` succeeds
   (private fork mirror — the vendored binary downloads from its release; if 404, stop
   and tell the human to request access from Aaron)
4. An LLM provider for the chat: `opencode auth login` after the binary is vendored
   (or `ANTHROPIC_API_KEY` in the environment). Without one, the free anonymous tier is
   used — functional but flaky; do not judge interview-quality bugs on the free tier.

## Setup (in order; each step has a check)

```bash
git clone git@github.com:harmoniqs/amicode.git && cd amicode
corepack enable && pnpm install               # check: exits 0, lockfile untouched
pnpm -r build                                 # check: packages/extension/dist/extension.js exists
pnpm --filter amicode run fetch:opencode   # check: vendor/opencode/<platform>/opencode exists
                                              # Default lock source=release: downloads the pinned,
                                              # features-ON binary from the harmoniqs/opencode release.
                                              # No clone, no bun. Only changing the fork needs those —
                                              # see "Changing opencode (the vendored fork)" below.
pnpm --filter amicode test                 # check: 200+ tests pass, 0 fail
bash packages/extension/scripts/install.sh    # Julia project (~15 min first precompile) + VSIX + lab.toml
node packages/extension/scripts/healthcheck.mjs   # check: 4/4 ✓ (julia, opencode, amico-run, creds)
```

macOS note: the vendored binary is unsigned — if Gatekeeper blocks it:
`xattr -d com.apple.quarantine packages/extension/vendor/opencode/darwin-arm64/opencode`

## Verification gates (run before claiming anything works)

| Gate | Command | Expect |
|---|---|---|
| Fast suite | `pnpm --filter amicode test` | all pass |
| Boot smoke | `pnpm --filter amicode run test:smoke` | `[smoke] PASS` |
| Julia solve E2E | `AMICO_TEST_JULIA_PROJECT=$HOME/.amico/julia pnpm --filter amicode run test:slow` | template vet passes, F > 0.999 |
| Live interview E2E | `cd packages/extension && AMICODE_E2E_LIVE=1 npx vitest run test/slow/interview_e2e.test.ts` | tiers A/B/C pass (C needs a provider; flaky on free tier) |
| Full chain (opt-in, ~3 min) | add `AMICODE_E2E_FULLCHAIN=1` | tier D: interview → real solve → F > 0.99 |

## Development facts you need

- **Dev host**: open this repo in VS Code, F5 ("Run Extension (amicode)"). The opencode
  server runs on **fixed port 43117** (`amicode.opencodePort`); Remote-SSH users forward it once.
- **The vendored binary is a build artifact** — never edit it; it comes from
  `harmoniqs/opencode` (thin fork, patch stack in its `AMICODE-PATCHES.md`). Rebrand/UI work
  happens THERE, product logic lives HERE in config/plugin/scores (Layer 0). To change the
  fork, see "Changing opencode (the vendored fork)" below.
- `packages/extension/opencode-plugin/` executes inside opencode's Bun runtime — it is NOT
  part of the extension bundle; keep it dependency-free; exactly one export.
- `packages/extension/scores/` — interview flows as data. New user path = new `SCORE.md`
  (see `scores/README.md`); lint gate: `pnpm --filter amicode test -- repertoire_lint`.
- Run artifacts land in `~/.amico/runs/default/<runId>/` (contract: `run.toml`, `AMICODE_ITER`
  lines, `iter_*.png`, `result.toml`, `pulse.jld2`, `FINISHED`). Validate files with
  `packages/schema/launcher/amico-validate <file>`.
- Never commit to `main`; branch + PR.

## Changing opencode (the vendored fork)

Default vendoring is `release` — `pnpm install` / `package` / F5 download the pinned,
features-ON binary; **no clone or bun needed**. You enter source mode only when you are
changing the fork, and you do it by running a command — **never** by editing the committed
`opencode.lock.json` `source` field (committing `local` forces a clone+bun build on everyone
and breaks fork-PR CI).

1. Clone the fork as a sibling and install bun:
   `git clone git@github.com:harmoniqs/opencode.git ../opencode` (or set `AMICODE_OPENCODE_SRC`);
   `curl -fsSL https://bun.sh/install | bash`.
2. Edit `../opencode`, then rebuild + re-vendor: **`pnpm --filter amicode opencode:build`**
   (builds with `OPENCODE_CHANNEL=dev` → amicode UI gate ON; `--any-ref` so your in-progress
   clone is accepted). Reload the Extension Dev Host (Cmd/Ctrl+R) to pick it up. This rebuilds
   the **compiled binary** — the only path that shows web-app surfaces (`packages/app`: home
   cards, v2 titlebar, draft flow), whose channel define is baked at build time (no `serve`-time
   hot path for those).
3. Ship it: push the opencode branch, tag a release (its workflow builds both binaries and
   gate-checks them), then **`pnpm --filter amicode opencode:pin <tag>`** here — it downloads
   and sha256-verifies both assets and rewrites the lock. Commit the lock bump + PR.

**Why `dev` matters:** every amicode surface is gated at runtime on
`settings.general.newLayoutDesigns`, whose default is `VITE_OPENCODE_CHANNEL !== "prod"`. A binary
built with `OPENCODE_CHANNEL=latest` (→ `"prod"`) compiles the features in but hides them.
`opencode:build` and the release workflow both force `dev`; `scripts/assert_ui_gate.sh` fails
CI and release if a binary ever ships with the gate off.

## Known sharp edges

- `test:slow` without `AMICO_TEST_JULIA_PROJECT` silently skips the Julia gates.
- The vendor `.sha256` stamp is the ACTUAL binary hash; `.source` records provenance
  (`local <ref>` or `release <repo>@<tag>`). Local-source installs always rebuild; a
  release-mode run re-downloads whenever the stamp differs from the lock manifest.
- Free-tier live e2e tiers are non-deterministic; a single tier-C failure is sampling noise.
- Julia 1.12.x minor-version drift vs the pinned Manifest prints a warning and proceeds.
