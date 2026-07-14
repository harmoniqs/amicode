# Features

A guided tour of Amicode's surfaces. Each one is a place you work, not a thing
you configure — the extension is a workflow, and these are its stages.

## Conversational solves

Ask for a gate or a state preparation in plain language. Amicode writes a
self-contained Piccolo script, runs the Ipopt solve, and captures the result —
no boilerplate, no parameter-guessing. A short guided exchange settles anything
it needs before it commits to code, so the script it produces is correct by
construction rather than by luck. You can stop a solve in flight with **Amicode:
Stop current solve**.

## Platform skills

The physics ships with the tool. Platform references for **neutral-atom
Rydberg**, **transmon**, **fluxonium**, **trapped-ion**, and **bosonic** systems
load on demand — the Hamiltonians, drive conventions, and construction patterns
are inlined into each script so it stands on its own. You never hand the
assistant a Hamiltonian; naming the platform is enough.

## Armonia

Amicode reads your **Armonia** — the stack of vaults you mount. Notes, specs,
experiment history, and your pulse catalog become first-class context the
assistant plans against, so a solve is informed by what your lab already knows.

Vaults layer by scope. A **personal** vault carries your profile, problem cards,
and running memory; **team** and **public** vaults stack on top. Mounts live
under `~/.amico/vaults` and appear in the **Armonia** view in the Activity Bar.
The **Vault** view browses the active vault's notes directly.

## Run Inspector

Watch a solve converge in real time. The Run Inspector overlays pulse plots,
traces fidelity and constraint-violation as they fall, and shows per-run
metrics. It's a webview panel — open it from the status bar or with **Amicode:
Open Run Inspector**, and select any past run with **Amicode: Select run to
inspect…**. Every run is captured to disk and revisitable; you can open a run's
directory on disk with **Amicode: Open current run directory**.

## Pulse Catalog

A versioned, warm-startable library of your best pulses. Retrieve the incumbent
for a `(platform, gate)`, warm-start a new solve from it, and promote a new best
when you beat it. Save the pulse from the current run with **Amicode: Save pulse
from current run**; browse and manage entries in the **Catalog** view. The
catalog is warm-start memory — the next solve for a problem you've already
touched starts from your last good answer, not from scratch.

## Hardware — QICK

Take an optimized pulse straight to a real RFSoC board through the QICK backend,
or run the *entire* closed loop against a pure-Julia mock with zero hardware —
ideal for development and CI. The boundary to the board is a deliberately coarse
three-verb transport, so the same script runs against the mock and the metal
unchanged.

The backend is **[IntonatoQICK.jl](https://github.com/harmoniqs/IntonatoQICK.jl)**.
See [Hardware](./hardware.md) for the full path from mock loop to real board.

## Open core

The extension and its platform skills are open. **Entitled builds** add
Harmoniqs's proprietary capabilities — GPU-accelerated solvers and closed-loop
hardware calibration — unlocked by the packages you have access to. Same editor,
same workflow; what you can reach is set by your entitlements.
