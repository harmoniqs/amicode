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
git checkout aaron/night-l0-pulse-designer   # the testing branch (PR #75) until merged
corepack enable && pnpm install               # check: exits 0, lockfile untouched
pnpm -r build                                 # check: packages/extension/dist/extension.js exists
pnpm --filter amicode-v2 run fetch:opencode   # check: vendor/opencode/<platform>/opencode exists
                                              # (downloads via gh from harmoniqs/opencode release)
pnpm --filter amicode-v2 test                 # check: 200+ tests pass, 0 fail
bash packages/extension/scripts/install.sh    # Julia project (~15 min first precompile) + VSIX + lab.toml
node packages/extension/scripts/healthcheck.mjs   # check: 4/4 ✓ (julia, opencode, amico-run, creds)
```

macOS note: the vendored binary is unsigned — if Gatekeeper blocks it:
`xattr -d com.apple.quarantine packages/extension/vendor/opencode/darwin-arm64/opencode`

## Verification gates (run before claiming anything works)

| Gate | Command | Expect |
|---|---|---|
| Fast suite | `pnpm --filter amicode-v2 test` | all pass |
| Boot smoke | `pnpm --filter amicode-v2 run test:smoke` | `[smoke] PASS` |
| Julia solve E2E | `AMICO_TEST_JULIA_PROJECT=$HOME/.amico/julia pnpm --filter amicode-v2 run test:slow` | template vet passes, F > 0.999 |
| Live interview E2E | `cd packages/extension && AMICODE_E2E_LIVE=1 npx vitest run test/slow/interview_e2e.test.ts` | tiers A/B/C pass (C needs a provider; flaky on free tier) |
| Full chain (opt-in, ~3 min) | add `AMICODE_E2E_FULLCHAIN=1` | tier D: interview → real solve → F > 0.99 |

## Development facts you need

- **Dev host**: open this repo in VS Code, F5 ("Run Extension (amicode-v2)"). The opencode
  server runs on **fixed port 43117** (`amicode.opencodePort`); Remote-SSH users forward it once.
- **The vendored binary is a build artifact** — never edit it; it comes from
  `harmoniqs/opencode` (thin fork, patch stack in its `AMICODE-PATCHES.md`). Rebrand/UI work
  happens THERE, product logic lives HERE in config/plugin/scores (Layer 0).
- `packages/extension/opencode-plugin/` executes inside opencode's Bun runtime — it is NOT
  part of the extension bundle; keep it dependency-free; exactly one export.
- `packages/extension/scores/` — interview flows as data. New user path = new `SCORE.md`
  (see `scores/README.md`); lint gate: `pnpm --filter amicode-v2 test -- repertoire_lint`.
- Run artifacts land in `~/.amico/runs/default/<runId>/` (contract: `run.toml`, `AMICODE_ITER`
  lines, `iter_*.png`, `result.toml`, `pulse.jld2`, `FINISHED`). Validate files with
  `packages/schema/launcher/amico-validate <file>`.
- Never commit to `main`; branch + PR. Testing feedback → PR #75 thread.

## Known sharp edges

- `test:slow` without `AMICO_TEST_JULIA_PROJECT` silently skips the Julia gates.
- The vendor `.sha256` stamp must match the lock manifest or `fetch:opencode` re-downloads.
- Free-tier live e2e tiers are non-deterministic; a single tier-C failure is sampling noise.
- Julia 1.12.x minor-version drift vs the pinned Manifest prints a warning and proceeds.
