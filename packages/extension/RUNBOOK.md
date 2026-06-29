# Amicode — one-lab install runbook (≤ 60 min)

Target: a clean macOS/Linux machine → Amicode demo-ready. Times are estimates;
the dominant cost is the first Julia precompile.

| # | Step | ~Time |
|---|------|------|
| 1 | Install Julia: `curl -fsSL https://install.julialang.org \| sh` (then restart your shell) | 5 min |
| 2 | Get the VSIX: in the amicode repo, `pnpm install && pnpm --filter amicode-v2 package` | 5 min |
| 3 | `bash packages/extension/scripts/install.sh` — instantiates the pinned Julia project (precompiles) + installs the VSIX + writes `~/.amico/lab.toml` | 15–25 min |
| 4 | Configure the LLM. (a) **Store the provider key** in the canonical location `~/.amico/llm.json`: `{"provider":"anthropic","key":"sk-ant-…"}` (`provider` ∈ `anthropic`, `openai`, `amazon-bedrock` — the value of `key` is the matching API key / Bedrock bearer token). The extension injects it into the opencode process at boot; storing or replacing it needs **no reinstall** — just edit the file. (b) **Select the model** in `~/.config/opencode/opencode.jsonc` so it matches that provider, e.g. `"model":"anthropic/claude-sonnet-4-6"` (or `amazon-bedrock/us.anthropic.claude-sonnet-4-6` + `"provider":{"amazon-bedrock":{"region":"us-east-1"}}`). Bedrock via `~/.aws`/`AWS_*` env still works without (a) — back-compat. | 5 min |
| 5 | `node packages/extension/scripts/healthcheck.mjs` → expect all ✓, exit 0 | 2 min |
| 6 | Open VS Code → Amicode chat → run a test gate; confirm the Run Inspector renders | 10 min |

## Troubleshooting (healthcheck failures)
- `✗ julia+project` → re-run `install.sh`; check `julia --version`.
- `✗ opencode /event` → `pnpm --filter amicode-v2 fetch:opencode`; re-run.
- `✗ amico-run` → `pnpm -r build` (stages `bin/`) or reinstall the VSIX.
- `✗ LLM creds: LLM creds not configured` → store a key in `~/.amico/llm.json` (step 4a), then re-run.
- `✗ LLM creds: …malformed` → the `~/.amico/llm.json` JSON or its `provider`/`key` is wrong; fix or remove it.

## Fallback (live solve or creds fail on-site)

If the live solve stalls, or Bedrock creds / opencode are unavailable at demo
time, run **Command Palette → "Amicode: Replay demo run"**. It stages a bundled
pre-baked converged solve into the runs root and the Run Inspector renders it
(iteration frames + final fidelity + promote prompt) — with **no Julia, no
opencode, and no credentials**. Arm it first (see `DEMO_CHECKLIST.md`).

> Actual timings are recorded during the β.6 demo dry-run (see `DEMO_CHECKLIST.md`).
