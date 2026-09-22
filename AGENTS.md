# Amicode — agent setup & testing guide

You are (probably) an agent asked to set up, develop, or test Amicode on this machine.
This file is the canonical path. The human-oriented test script is
`packages/extension/TESTING.md`; design authority lives in the `harmoniqs/amicissimo` vault
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
3. `gh auth status` succeeds (for PRs and issues)
4. bun (for compiling the engine binary): `curl -fsSL https://bun.sh/install | bash`
5. An LLM provider for the chat: `opencode auth login` after the binary is built
   (or `ANTHROPIC_API_KEY` in the environment). Without one, the free anonymous tier is
   used — functional but flaky; do not judge interview-quality bugs on the free tier.

## Setup (in order; each step has a check)

```bash
git clone git@github.com:harmoniqs/amicode.git && cd amicode
corepack enable && pnpm install               # check: exits 0, lockfile untouched
pnpm -r build                                 # check: packages/extension/dist/extension.js exists
pnpm --filter amicode run build:binary    # check: vendor/opencode/<platform>/opencode exists
                                              # Compiles the engine from packages/app-bundle/overlay/.
                                              # Requires bun. No external fork or download needed.
pnpm --filter amicode test                 # check: 200+ tests pass, 0 fail
bash packages/extension/scripts/install.sh    # Julia project (~15 min first precompile) + VSIX + lab.toml
node packages/extension/scripts/healthcheck.mjs   # check: 4/4 ✓ (julia, opencode, amico-run, creds)
```

## Repo sync (one-command drift check)

Fleet + vendor + lock drift is how the last 3 fleet breaks hid (stale `main` behind `origin/main`, stale `~/.local/bin` guard, tunnel `30/3` → `15/2`, vendor `local` vs `release`). One check replaces the whole checklist:

```bash
pnpm sync              # check only: git fetch + gh auth + pnpm dry-run + fleet gate (no writes)
pnpm sync --fix        # also writes: git pull --ff-only, pnpm install, build:binary, fleet install
# or: bash scripts/repo-sync.sh --check / --fix
# VS Code: Command Palette → Amicode: Repo Sync (runs --fix in a terminal)
```

`--check` is the CI twin (no network mutates beyond `git fetch --prune` + `gh` probes). `--fix` is idempotent and safe to re-run whenever `main` feels stale or the panel is stranded. Fleet machine-scoped settings (`~/.local/bin` guard, `~/Library/LaunchAgents` tunnel, `settings.json:opencodeBinary/Port`) are only repaired by `bash tools/fleet/install.sh` / `Fleet — Repair`, never by `repo-sync` alone — `repo-sync` just reports the `FAIL` with the fix line.

## Amicode terminal (bundled canonical opencode)

The integrated terminal's `opencode` is now the **vendored, amicode-aware binary** — the same `vendor/opencode/<platform>/opencode` + the same `OPENCODE_CONFIG_CONTENT` the chat server was spawned with. `Amicode: Open Amicode Terminal` (Command Palette) opens a shell whose `PATH` is prepended with `vendor/opencode/<platform>` (so `opencode` resolves to the vendored one) and `bin/launcher` (so `amico`/`amico-run` resolve), and whose env carries `OPENCODE_CONFIG_CONTENT` + `OPENCODE_SERVER_PASSWORD` + `AMICO_FLEET_FALLBACK`. That terminal's `opencode` knows about fleet/guard/fallback and the per-workspace skills/vault mounts, so `opencode` there can diagnose the same panel the user sees (`pnpm sync --check`, `bash tools/fleet/install.sh --check`, `amico fleet ...`), and `amico`/`pnpm sync` etc. all work without extra `PATH` setup. The terminal is a normal shell (not an opencode TUI) — run `opencode` on demand; `Amicode: Open Amicode Terminal` with arg `opencode` opens the TUI directly.

macOS note: the vendored binary is unsigned — if Gatekeeper blocks it:
`xattr -d com.apple.quarantine packages/extension/vendor/opencode/darwin-arm64/opencode`

## Verification gates (run before claiming anything works)

| Gate | Command | Expect |
|---|---|---|
| Fast suite | `pnpm --filter amicode test` | all pass |
| Engine typecheck | `pnpm test:engine` | opencode typecheck clean (base-drift errors allowlisted, tracked in #1229) |
| Engine unit tests | `pnpm test:engine:unit` | opencode suite green (minus base-drift `llm-native-recorded`, #1229) |
| Boot smoke | `pnpm --filter amicode run test:smoke` | `[smoke] PASS` |
| Julia solve E2E | `AMICO_TEST_JULIA_PROJECT=$HOME/.amico/julia pnpm --filter amicode run test:slow` | template vet passes, F > 0.999 |
| Live interview E2E | `cd packages/extension && AMICODE_E2E_LIVE=1 npx vitest run test/slow/interview_e2e.test.ts` | tiers A/B/C pass (C needs a provider; flaky on free tier) |
| Full chain (opt-in, ~3 min) | add `AMICODE_E2E_FULLCHAIN=1` | tier D: interview → real solve → F > 0.99 |

## Development facts you need

- **Dev host**: open this repo in VS Code, F5 ("Run Extension (amicode)"). The opencode
  server runs on **fixed port 43117** (`amicode.opencodePort`); Remote-SSH users forward it once.
- **The vendored binary is a build artifact** — never edit it; it is compiled from
  `packages/app-bundle/overlay/` (the engine source tree). To change the engine,
  see "Changing the engine (opencode patches)" below.
- **`packages/app-bundle/overlay/` IS the source of truth** — edit it directly.
  This is the canonical engine source tree committed in this repo. Run
  `pnpm --filter amicode run build:binary` after editing to compile a new binary.
- `packages/extension/opencode-plugin/` executes inside opencode's Bun runtime — it is NOT
  part of the extension bundle; keep it dependency-free; exactly one export.
- `packages/extension/scores/` — interview flows as data. New user path = new `SCORE.md`
  (see `scores/README.md`); lint gate: `pnpm --filter amicode test -- repertoire_lint`.
- Run artifacts land in `~/.amico/runs/default/<runId>/` (contract: `run.toml`, `AMICODE_ITER`
  lines, `iter_*.png`, `result.toml`, `pulse.jld2`, `FINISHED`). Validate files with
  `packages/schema/launcher/amico-validate <file>`.
- **New sessions open on opencode's `plan` agent** (plan-first posture for all
  users): `buildOpencodeConfigContent` injects `default_agent: "plan"` and
  `agent_order: ["plan", "build", "develop", "research"]` — the four-mode
  surface (spec-20260907-011500 D1 rev 3, #858/#868: autodev → develop,
  autoresearch → research; old ids read-resolve for one release cycle;
  `build` is a named, selectable tile AND the default posture — marked
  default in the picker, a valid explicit id). The pulse-designer agent
  shell is retired (#389); the interview content lives in the compiled
  AGENTS.md score section, visible to every agent.
- Never commit to `main`; branch + PR.

## Changing the engine (opencode patches)

The engine source lives in `packages/app-bundle/overlay/packages/opencode/`.
Edit it in place — the overlay IS the source of truth (there is no external fork).

1. Edit files under `packages/app-bundle/overlay/packages/opencode/`
2. Run `pnpm --filter amicode run build:binary` to compile
3. Reload the Extension Dev Host (Cmd/Ctrl+R) to pick up the new binary

bun is required for compilation. The overlay is committed directly;
there is no fork to push to.

**Why `dev` matters:** every amicode surface is gated at runtime on
`settings.general.newLayoutDesigns`, whose default is `VITE_OPENCODE_CHANNEL !== "prod"`. A binary
built with `OPENCODE_CHANNEL=latest` (→ `"prod"`) compiles the features in but hides them.
The build script forces `dev`; `scripts/assert_ui_gate.sh` fails
CI and release if a binary ever ships with the gate off.

## Releasing & publishing (amicode → Marketplace)

Two channels. **`vX.Y.Z-alpha.N`** is internal: it cuts a GitHub *prerelease* for direct install
and never reaches end users.
**`vX.Y.Z`** (clean, no suffix) is the only tag that publishes to the VS Code Marketplace.

Version knobs that must agree: the **extension manifest** (`packages/extension/package.json`
version) must equal the **tag base** (`v0.0.3` and `v0.0.3-alpha.5` both → `0.0.3`) — enforced by
release.yml's version guard (a gate, not a bump; edit the manifest by hand when a cycle starts).

**`.github/workflows/release.yml`** — trigger: push any `v*` tag (or `workflow_dispatch` with
`tag`). Builds the engine binary from the overlay and packages **seven** vsixes. Four are
installable — `amicode.vsix` (universal, all binaries), `amicode-linux-x64.vsix`,
`amicode-linux-arm64.vsix`, `amicode-darwin-arm64.vsix` — and are the GitHub Release assets.
Three are **cover packages** carrying NO binary — `win32-x64`, `win32-arm64`, `darwin-x64` —
published to the Marketplace and nowhere else. A clean `vX.Y.Z` tag publishes all six
platform-targeted VSIX files from the same packaging job; no Actions-artifact handoff sits between
the build and Marketplace publish.

**`linux-arm64` is a real target, not a cover** — it carries a binary and serves arm64
devcontainers (VS Code Remote-Containers on Apple Silicon, the common case). The extension runs
inside the container, so that host needs a native binary, not advice. It is subject to the same
publish-time rule as the covers below: leave it out of a release and arm64 Linux clients resolve
down to the stale `0.0.2` universal.

**Why cover packages exist (do not drop them).** On the Marketplace a *missing* target is not
neutral: VS Code resolves a client whose target platform has no entry down to the newest
**universal** version on the listing and installs it silently. Ours is `0.0.2` — the last release
before the platform split — so from `0.0.3` through `0.1.1` every Windows and Intel-Mac install
silently landed on a stale build that reported itself as the latest version. A version's target
set is fixed at publish time (you cannot add a target to a published version), so the cover has to
ride along with every release. They resolve to the current version and land in
`unsupportedHostAdvice()` (`src/opencode_binary.ts`), which is the only user-facing thing they do.
A packaging step fails the build if a cover package smuggled a binary in.

**Windows = WSL**, and it is served by `amicode-linux-x64.vsix` installed into the WSL host —
never by `win32-*`. The extension declares `"extensionKind": ["workspace"]`, so it installs
where the workspace is (that is also VS Code's inferred default for a `main` extension; it is
declared so the placement is explicit rather than inferred).

Needs the **`VSCE_PAT`** repo secret (an Azure DevOps PAT: org = all accessible, scope
Marketplace → Manage, <=1yr expiry, so rotate). Open VSX is deferred — issue #176 (needs
`OVSX_TOKEN`).

**`.github/workflows/promote.yml`** — the deliberate "this alpha is good enough" act.
`workflow_dispatch`, input `alpha_tag` (e.g. `v0.0.3-alpha.5`). Validates it (real pre-release
tag, its clean `vX.Y.Z` not yet taken, every check run green on that commit), cuts the clean tag
at the alpha's exact SHA, and dispatches release.yml. It does **not** touch the manifest; if the
base was already promoted it fails and tells you to bump + start a fresh alpha cycle.

Typical cycle: bump manifest → push `v0.0.3-alpha.1..N` (internal prereleases) → when one
passes, **promote** it → clean `v0.0.3` → Marketplace. The first promotion of a base needs no
bump (alphas never hit the Marketplace, so the version is still free); re-promoting an
already-published base does.

## Known sharp edges

- `test:slow` without `AMICO_TEST_JULIA_PROJECT` silently skips the Julia gates.
- Free-tier live e2e tiers are non-deterministic; a single tier-C failure is sampling noise.
- Julia 1.12.x minor-version drift vs the pinned Manifest prints a warning and proceeds.
- A tag pushed by CI's `GITHUB_TOKEN` does not fire `release.yml`'s `push` trigger (Actions'
  recursion guard), so `promote.yml` dispatches release.yml explicitly — `workflow_dispatch` is
  exempt from that guard.
