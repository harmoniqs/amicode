---
name: solve
description: Run a Piccolo optimization script with correct Julia flags. Use when the user asks to run/solve/optimize a .jl script.
agents: [experimenter, engineer]
surface: public
scenarios: [launch-seam-missing-solvespec]
---

> **Prerequisites:** Assumes `/setup` conventions for problem structure. After solving, invoke `/plot` to generate the standard plot set for the result.

Run a Piccolo optimization script with the correct Julia flags.

## Usage

`/solve <script_path> [max_iter]`

The argument is: $ARGUMENTS

## Instructions

When running any Julia optimization script in this monorepo, ALWAYS use the flags and launch
pattern below. The operational detail beyond that lives in `references/` and is loaded on
demand:

- **[references/campaigns.md](references/campaigns.md)** — background execution + one
  per-campaign log, streaming output, multi-phase chaining, HSL linear-solver fallback.
- **[references/output.md](references/output.md)** — what to report after a run, the
  save-after-every-stage requirement, Ipopt output parsing, checkpoint restart.

### Required flags

```bash
julia -t auto --project=<project_dir> <script_path> [args...]
```

| Flag | Why |
|------|-----|
| `-t auto` | Multithreading — Ipopt + integrator evaluations benefit from parallel threads |
| `--project=<dir>` | Activate the correct Julia project environment |

### BLAS threading

Scripts MUST set `BLAS.set_num_threads(1)` near the top (before heavy computation). Without
this, OpenBLAS spawns its own threads that compete with Julia's `-t auto` threads, causing
oversubscription and slowdowns. The pattern is:

```julia
using LinearAlgebra
BLAS.set_num_threads(1)
```

When reviewing or writing optimization scripts, check that this is present. If missing, add
it.

### Determine the project directory

- If the script is inside a standalone demo repo (e.g., `atoms-demo/`), use `--project=.`
  from within that repo
- If the script is in a subpackage like `Piccolo.jl/`, use `--project=Piccolo.jl`
- If the script has `Pkg.activate(...)` at the top, use that path instead

### Timeout

Optimization scripts can run for a long time. Use a **10-minute timeout**
(`timeout=600000`).

### Background launch (the core pattern)

Run in the background with `nohup` + `&`, streaming to **one log file per campaign** (not per
invocation). Then tell the user the log path and how to stream it:

```bash
# First run in a campaign — create the log:
cd <project_dir> && nohup julia -t auto --project=. <script_path> [args...] > /tmp/<campaign>.log 2>&1 &
# Subsequent runs in the same campaign — append (>>) to the same log.
```

```
Optimization running in background (PID: XXXX). Stream the output with:
  tail -f /tmp/<campaign>.log
```

See references/campaigns.md for the append pattern, multi-phase chaining, and the HSL
fallback; references/output.md for after-run reporting, save-between-stages, Ipopt parsing,
and checkpoint restart.

### After running (summary — full detail in references/output.md)

- Report final fidelity + wall time; note warnings (missing `Δt_bounds`, HSL failures).
- Multi-stage scripts MUST save the pulse after **every** `solve!` (not just at the end):
  `jldsave(path; pulse = get_pulse(qcp.qtraj))`. A stage whose pulse was not saved cannot be
  warm-started from or verified independently.
- Parse Ipopt: `Number of Iterations`, `Objective`, `Overall NLP` status, `inf_pr` (< 1e-6).
- Checkpoint restart: verify the file is non-empty and initial fidelity matches the saved
  value; a 0/NaN initial fidelity means the checkpoint is corrupt — restart from scratch.
