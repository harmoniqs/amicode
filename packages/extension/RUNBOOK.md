# Amicode — one-lab install runbook (≤ 60 min)

Target: a clean macOS/Linux machine → Amicode demo-ready. Times are estimates;
the dominant cost is the first Julia precompile.

| # | Step | ~Time |
|---|------|------|
| 1 | Install Julia: `curl -fsSL https://install.julialang.org \| sh` (then restart your shell) | 5 min |
| 2 | Get the VSIX: in the amicode repo, `pnpm install && pnpm --filter amicode-v2 package` | 5 min |
| 3 | `bash packages/extension/scripts/install.sh` — instantiates the pinned Julia project (precompiles) + installs the VSIX + writes `~/.amico/lab.toml` | 15–25 min |
| 4 | Configure Bedrock: create `~/.config/opencode/opencode.jsonc` with `"model": "amazon-bedrock/us.anthropic.claude-sonnet-4-6"` and `"provider": {"amazon-bedrock": {"region": "us-east-1"}}`; ensure AWS creds (env `AWS_*`/`AWS_PROFILE` or `~/.aws/credentials`) | 5 min |
| 5 | `node packages/extension/scripts/healthcheck.mjs` → expect all ✓, exit 0 | 2 min |
| 6 | Open VS Code → Amicode chat → run a test gate; confirm the Run Inspector renders | 10 min |

## Troubleshooting (healthcheck failures)
- `✗ julia+project` → re-run `install.sh`; check `julia --version`.
- `✗ opencode /event` → `pnpm --filter amicode-v2 fetch:opencode`; re-run.
- `✗ amico-run` → `pnpm -r build` (stages `bin/`) or reinstall the VSIX.
- `✗ LLM creds` → fix the opencode model/provider + AWS creds, then re-run.

## Fallback (live solve or creds fail on-site)

If the live solve stalls, or Bedrock creds / opencode are unavailable at demo
time, run **Command Palette → "Amicode: Replay demo run"**. It stages a bundled
pre-baked converged solve into the runs root and the Run Inspector renders it
(iteration frames + final fidelity + promote prompt) — with **no Julia, no
opencode, and no credentials**. Arm it first (see `DEMO_CHECKLIST.md`).

> Actual timings are recorded during the β.6 demo dry-run (see `DEMO_CHECKLIST.md`).
