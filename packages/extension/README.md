# Amicode

### Quantum optimal control, driven by conversation.

Describe the gate you want in plain language. Amicode designs the pulse, runs the
solve, and shows you the result — without leaving your editor.

Amicode turns a natural-language description of a control problem into an
LLM-authored [Piccolo.jl](https://github.com/harmoniqs/Piccolo.jl) (Julia)
optimization, runs it, and streams the result back into native VS Code panels.
The physics, the solver idioms, and your lab's accumulated knowledge ride along
as context — so the script it writes is correct by construction, not by luck.

## What you get

- **Chat-driven pulse design** — an in-editor copilot (Amico) that authors and
  runs the Julia optimization for the gate or state you describe.
- **Live Run Inspector** — watch the solve converge in a native panel: objective,
  constraints, and the resulting pulse.
- **Managed Julia toolchain** — first run offers to install Julia (via juliaup),
  pin the right version, and provision the Piccolo environment for you.
- **A personal vault** — your systems, pulses, and problems are remembered across
  sessions, stored locally under `~/.amico`.

## Requirements

- An LLM provider configured for the chat engine.
- Julia — Amicode manages the install on first run; nothing to set up by hand.

Run **Amicode: Healthcheck** from the Command Palette any time to verify your
setup (Julia environment, chat server, and provider).

---

<sub>A VS Code extension · built on [Piccolo.jl](https://github.com/harmoniqs/Piccolo.jl) · chat harness vendored from [opencode](https://github.com/sst/opencode) (MIT). Pre-release software.</sub>
