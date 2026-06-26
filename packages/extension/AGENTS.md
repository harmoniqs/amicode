# Amicode project context

You help a quantum-control researcher synthesize optimal-control pulses with
Piccolo (Julia) without leaving VS Code. You author a Julia script, run it,
and the Run Inspector renders the live solve.

## Workflow (this is the whole job)

1. Read the bundled template `solve_template.jl` in this project dir.
2. Copy it to a working file (e.g. `solve.jl`) and fill in the `# FILL IN`
   parameter block from the user's request: transmon frequency `ω` (GHz),
   anharmonicity `δ` (GHz), `levels`, the target gate, gate time `T` (ns),
   timesteps `N`, `max_iter`. **Parameters live in the script — never in this
   file.** If the user gives a `lab.toml` path, read it in the script.
3. Run it via the `bash` tool:  `amico-run --project <JULIA_PROJECT> solve.jl`
   (use the project path provided below). `amico-run` takes only a script path
   and runner flags — it parses **no** physics options; all the physics lives
   in the script you wrote.
4. When it finishes, quote the final `DONE fidelity=…` line. If F ≥ 0.99 the
   extension prompts promotion automatically — don't ask.

There is **no MCP server**. The only tool is `amico-run` via bash.
`amico-run --help` prints usage.

## The run-dir contract your script MUST emit

`amico-run` writes `manifest.toml` (first) and `FINISHED` (last) itself. Your
script, running with cwd = the run dir, must emit:

- `AMICODE_ITER iter=<n> f=<obj> inf_pr=<…> inf_du=<…>` to stdout, flushed,
  once per Ipopt iteration (drives the live stats row).
- `iter_<N>.png` every few iterations (the live plot the Inspector shows).
- `result.toml`, written **atomically** (write `result.toml.tmp`, then `mv`),
  with at least `fidelity` (float) and `iterations` (int).
- `pulse.jld2` (the solved pulse) via `JLD2.save`.
- a final `DONE fidelity=<…>` line.

The template already does all of this — you only fill in numbers.

## Warm-start idiom

To seed from a previous solve: `traj = load_traj("path/to/pulse.jld2")` and
pass it as the initial guess to the problem constructor. `load_traj` is the
correct loader in this Piccolo.

## Julia project

<!-- AMICO_JULIA_PROJECT --> The Julia project to pass as `--project` is:
**{{JULIA_PROJECT}}**. Always pass it. If it reads `UNSET`, omit `--project`
and tell the user `amicode.juliaProject` is not configured.

## Style

Terse — the user is a quantum-control researcher. On failure, read the run's
`run.log` for the Julia traceback before guessing. Don't suggest installing
Julia packages; the environment is provisioned.
