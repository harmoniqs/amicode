# Amicode run-dir contract — β freeze (wk-3, Phase-β DoD)

This is the **frozen** contract every Amicode solve emits and the Run Inspector
consumes. It is the seam between the orchestrator (`@amicode/amico-run`, β.1),
the bundled agent (`AGENTS.md` + `solve_template.jl`, β.3), and the extension's
watcher/inspector. **Frozen for the β phase** — changes after wk-3 go through
Phase 0' (the SchemaPackage supersedes the provisional validators below).

## Layout

A run lives at `~/.amico/runs/<lab-id>/<runId>/`, where `runId` is
`r<UTC-timestamp>Z-<hex>` (e.g. `r20260617-161814Z-e8cb`). `amico-run` writes
`manifest.toml` **first** and `FINISHED` **last**; the script (cwd = the run dir)
emits the rest.

| Artifact | Writer | Contents |
|---|---|---|
| `manifest.toml` | amico-run (first) | `schema_version = "1"`, snake_case keys: `run_id`, `lab`, `lab_id`, `script_path`, `created_at`, `orchestrator_version`, and a `[julia]` table (`binary`, optional `project`/`sysimage`). |
| `run.log` | amico-run (stdout tee) | One `AMICODE_ITER iter=<n> f=<obj> inf_pr=<…> inf_du=<…>` line per Ipopt iteration (drives the live stats row), plus a final `DONE fidelity=<…>` line and any Julia traceback. |
| `iter_<N>.png` | script | Per-iteration pulse/fidelity plot. `N` is the iteration with **unbounded digits** (`iter_0`, `iter_10`, … `iter_0060`). The inspector globs `iter_*.png`. |
| `result.toml` | script (atomic) | Written `result.toml.tmp` then renamed. At least `fidelity` (float) and `iterations` (int); `wall_seconds` optional. |
| `FINISHED` | amico-run (last, terminal) | `status = "completed" | "failed" | "aborted"` and `exit_code` (int). Its presence is the **only** completion signal — the inspector fires `onFinished` solely on a valid `FINISHED`, so a killed solve shows "running", never a false success. |

Two convenience files live at the **lab runs root** (`~/.amico/runs/<lab-id>/`):

| File | Writer | Contents |
|---|---|---|
| `index` | amico-run (`appendIndex`) | Append-only, tab-separated `<runId>\t<createdAt>\t<scriptPath>` per run. |
| `latest` | amico-run (`updateLatest`) | Symlink → the most recent `<runId>`; written via temp-then-rename so the watcher sees an atomic swing. The inspector follows `latest`. |

## Frozen schemas

The provisional validators in `@amicode/amico-run` are the β source of truth:

- `validateManifest` — `schema_version === "1"`; the six string keys non-empty; a `[julia]` table with a string `binary`.
- `validateFinished` — `status` ∈ {completed, failed, aborted}; integer `exit_code`.
- `validateResult` — numeric `fidelity`; integer `iterations`.

These are **frozen for β**. The Phase 0' SchemaPackage replaces them; any contract
change before then is a breaking change to the watcher and must be coordinated.

## Exit codes (amico-run)

- `0` — `FINISHED.status == "completed"`.
- `130` — `aborted` (SIGINT/SIGTERM, e.g. the inspector's stop control).
- `64` — usage/config error, orchestrator fault (any unexpected throw), or a
  missing `FINISHED` (write fault).
- otherwise — the Julia process's return code (a `failed` run; `1` if it failed
  with a zero return code).
