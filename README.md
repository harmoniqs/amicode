<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/extension/media/amico-tab-dark.svg">
  <img alt="Amicode" src="packages/extension/media/amico-tab-light.svg" width="96">
</picture>

# Amicode

### Quantum optimal control, driven by conversation.

Describe the gate you want in plain language. Amicode designs the pulse, runs the
solve, and shows you the result — without leaving your editor.

<sub>A VS Code extension · built on [Piccolo.jl](https://github.com/harmoniqs/Piccolo.jl) · chat harness vendored from [opencode](https://github.com/sst/opencode)</sub>

</div>

---

Amicode turns a natural-language description of a control problem into an
LLM-authored Julia optimization, runs it, and streams the result back into native
editor panels. The physics, the solver idioms, and your lab's accumulated
knowledge all ride along as context — so the script it writes is correct by
construction, not by luck.

## What it does

**Conversational solves.** Ask for a gate or a state preparation; Amicode writes a
self-contained Piccolo script, runs the Ipopt solve, and captures the result. No
boilerplate, no parameter-guessing.

**Physics that ships with the tool.** Platform references for neutral-atom Rydberg,
transmon, fluxonium, trapped-ion, and bosonic systems load on demand — the
Hamiltonians, drive conventions, and construction patterns are inlined into each
script so it stands on its own.

**Your knowledge, mounted.** Amicode reads your **Armonia** — the stack of vaults
you mount (personal, team, public). Notes, specs, experiment history, and your
pulse catalog become first-class context the assistant plans against.

**A live run inspector.** Watch a solve converge in real time: overlaid pulse
plots, fidelity and constraint-violation traces, per-run metrics. Every run is
captured and revisitable.

**A pulse catalog.** A versioned, warm-startable library of your best pulses —
retrieve the incumbent for a `(platform, gate)`, warm-start from it, and promote a
new best when you beat it.

**Straight to hardware.** Drive real RFSoC devices through the QICK backend, or run
the *entire* closed loop against a pure-Julia mock with zero hardware for
development and CI.

## Hardware — QICK / RFSoC

Amicode's hardware path is [**IntonatoQICK.jl**](https://github.com/harmoniqs/IntonatoQICK.jl),
a QICK backend that bridges an optimized pulse to an RFSoC board over a deliberately
**coarse three-verb boundary** (`upload_pulse!` / `trigger!` / `readout`). All tProc-v2
specifics live board-side, so the firewall between you and the lab is just a transport.
The whole loop runs — and is tested — with **no Python and no board** via the built-in
mock, then swaps to real hardware unchanged.

> **QICK v2 backend & docs → [github.com/harmoniqs/IntonatoQICK.jl](https://github.com/harmoniqs/IntonatoQICK.jl)**

## Install

Search **Amicode** in the VS Code Extensions view, or grab a `.vsix` from
[Releases](https://github.com/harmoniqs/amicode/releases/latest).

Amicode runs on **Linux (x64 and arm64)** and **macOS (Apple Silicon)**. It runs wherever your
*workspace* lives, so on a remote it installs into that host's extension host, not your
laptop — pick the artifact for the **remote**, not for the machine running the VS Code
window.

**On Windows, use WSL.** There is no native Windows build; the chat harness Amicode
drives is built for Linux and macOS only. Open your project in WSL (**Remote — WSL**),
then install Amicode from the Extensions view *in that window* — VS Code installs it into
the WSL host, which is Linux. Installing into the Windows side instead gets you an
extension that activates and then tells you to do this.

To install a `.vsix` into WSL by hand, download and install it **from inside WSL** so it
lands in the WSL host rather than on Windows:

```bash
curl -fL -o /tmp/amicode.vsix \
  https://github.com/harmoniqs/amicode/releases/latest/download/amicode-linux-x64.vsix
code --install-extension /tmp/amicode.vsix
```

## Try it

Open the Amicode panel and paste:

> Design a minimum-time single-qubit X gate for a transmon (3 levels, penalize
> leakage to |2⟩). Then run the optimized pulse through the IntonatoQICK mock
> backend, read out the populations, and plot both the pulse and the readout.

## Open core

The extension and its platform skills are open. **Entitled builds** add
Harmoniqs's proprietary capabilities — GPU-accelerated solvers and **closed-loop
hardware calibration** — unlocked by the packages you have access to. Same
editor, same workflow; what you can reach is set by your entitlements.

## Develop

```bash
pnpm install
pnpm run build      # esbuild → dist/extension.js
pnpm test           # vscode-shim smoke tests
```

See [`AGENTS.md`](./AGENTS.md) for the in-editor project conventions the extension
sets up.

---

<div align="center">
<sub>Built by <a href="https://harmoniqs.co">Harmoniqs</a> · quantum control, composed.</sub>
</div>
