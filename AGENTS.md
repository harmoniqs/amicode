# Amicode project context

This is the Amicode VS Code extension's per-session opencode project. You're
running here so a developer can iterate on quantum-optimal-control pulses
without leaving their editor.

## Your tools (use bash, not MCP)

There is **no MCP server** in this project. The single domain-specific tool
is a CLI binary you invoke via the `bash` tool:

### `amico-run`

Solves for an optimal control pulse using Piccolo / Piccolissimo (Julia).
Writes per-iteration PNGs + a final result.toml to disk; the VS Code Run
Inspector panel auto-refreshes as the solve runs.

**Invoke via:**

```bash
amico-run --system <qubit|transmon> \
          --gate <X|Y|Z|H|S|T|CNOT|CZ|SWAP|iSWAP> \
          --pulse <zero-order|linear-spline> \
          [--T-ns <float>] [--omega-cap <float>] [--max-iter <int>]
```

`amico-run --help` prints full usage.

**Arg guidance** (pick sensible defaults if the user doesn't specify):

- `--system`: `qubit` for textbook Pauli (X/Y/Z drift); `transmon` for the
  physical 4-level Duffing model. Default `transmon` if the user mentions
  "qubit hardware," "transmon," "leakage," or any GHz frequency. Default
  `qubit` if they say "toy example" or "Pauli."
- `--gate`: literally what they asked for. `X`/`Y`/`Z`/`H`/`S`/`T` are 1q;
  `CNOT`/`CZ`/`SWAP`/`iSWAP` are 2q. (`CNOT` and `CX` are aliases.)
- `--pulse`: `zero-order` (piecewise-constant) is the safe default and runs
  faster. `linear-spline` for smoother controls when the user asks about
  bandwidth, smoothness, or DRAG-style shaping.
- `--T-ns`: default 10 ns for `qubit`, 24 ns for `transmon` 1q gates,
  ~150-300 ns for 2q gates. Don't pass if the user didn't specify.
- `--omega-cap`: transmon-only; default 0.05 (50 MHz). Above 0.15 GHz the
  RWA / weak-anharmonic approximation degrades.
- `--max-iter`: leave off unless the user explicitly limits or extends.

**Hazard checks** (call these out to the user *before* invoking the tool):

- transmon + 1q + T < 20 ns → likely F ≲ 0.95; suggest T ~30-40 ns or higher ω cap.
- transmon + 2q + T < 150 ns → likely won't converge; suggest 150-300 ns.
- transmon + omega_cap > 0.15 GHz → expect leakage to |2⟩; rollout vs solver F will diverge.

**Output**:

Each run lands in `/tmp/amicode-runs/<runId>/` and the symlink
`/tmp/amicode-runs/latest` points at it. The user sees the live iter PNGs
in the VS Code Run Inspector panel — you don't have to display them.

When `amico-run` finishes, it prints a one-line `DONE` summary with the
fidelity. Quote that back to the user. If F ≥ 0.99, the extension will
automatically prompt them to promote the pulse to the catalog — you don't
need to ask.

## Style

- Be terse. The user is a quantum-control researcher; don't explain quantum
  mechanics unless asked.
- Run `amico-run --help` first if you're unsure of an arg.
- If a run fails, read `/tmp/amicode-runs/latest/run.log` for the actual
  julia traceback before guessing.
- Don't suggest installing new Julia packages. The dev environment is
  pinned at `/tmp/amicode-spike-julia` and the user maintains it.
