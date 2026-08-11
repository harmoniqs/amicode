# Amicode

### Open autonomous research, starting with quantum control.

Your vaults, your fleet, your devices, your pulses — composed by conversation.

Amicode is an **open autonomous research studio** in VS Code. Describe what you want — a gate, a state preparation, a calibration sweep — and it designs the pulse, runs the solve, and shows you the result. Every run is captured, every pulse versioned for warm-start, and every session distilled into durable knowledge. We start with quantum control — the hardest physical system to prove the loop on — and generalize to any physical system you can model.

## What you get

- **Open autonomous research** — Amico, your copilot, authors a self-contained [Piccolo.jl](https://github.com/harmoniqs/Piccolo.jl) optimization from plain language, runs it, and streams the result to native panels. A short guided exchange settles parameters before code is committed. You can stop a solve in flight with **Amicode: Stop current solve**.
- **Open system management, not just a chat panel** — the workspace is what you edit; `~/.amico` is what the system manages (vaults, runs, catalog, devices). Amicode is the lens: Vault tree, Run Inspector, Catalog, and Device Inspector render managed state semantically instead of as file trees.
- **Vaults — your knowledge, mounted** — personal + team + project vaults stacked under `~/.amico/vaults/` (your notes, specs, experiment history, pulse catalog) become first-class context the assistant plans against. Works fully offline; scales to a team via vault mounts with `local | team | public` visibility and PR-based promotion.
- **Fleet management — one logical studio across machines** — vault sync, canonical chat DB, and WIP that follows you between hosts over an SSH mesh. Solo, team, and fleet share the same invariants: one-file-per-note, a computed catalog index, per-session captures, and device locks. When the canonical is unreachable, `Amicode: Fleet — Enter Local Fallback` lets you work offline and `Rejoin` merges back; `Amicode: Fleet — Repair` and `pnpm sync` keep guard/tunnel/vendor in sync.
- **Live execution + versioned memory** — the **Run Inspector** overlays pulse plots and traces fidelity and constraint violation as they fall; the **pulse catalog** keeps a warm-startable, versioned library of your best pulses and promotes when you beat the incumbent.
- **Straight to hardware** — drive real RFSoC boards via [IntonatoQICK.jl](https://github.com/harmoniqs/IntonatoQICK.jl) over a coarse three-verb boundary (`upload_pulse!` / `trigger!` / `readout`), or run the *entire* closed loop against a pure-Julia mock with zero hardware for dev and CI. Same script, mock or metal.
- **Physics that ships with the tool** — platform references for **Rydberg**, **transmon**, **fluxonium**, **trapped-ion**, and **bosonic** systems inline the Hamiltonians and drive conventions into each script so it stands alone.
- **Skills are the product** — 37 public skills ship in the vsix, versioned with the product; your own vault mounts and Julia-package skills layer on top behind entitlements.

<sub>Full studio tour, hardware docs, and the skill index → [github.com/harmoniqs/amicode](https://github.com/harmoniqs/amicode)</sub>

## Try it

Open the Amicode panel and paste:

> Design a minimum-time single-qubit X gate for a transmon (3 levels, penalize leakage to |2⟩). Then run the optimized pulse through the IntonatoQICK mock backend, read out the populations, and plot both the pulse and the readout.

## Requirements

- An LLM provider configured for the chat engine.
- Julia — Amicode manages the install on first run; nothing to set up by hand.

Run **Amicode: Healthcheck** from the Command Palette any time to verify your setup (Julia environment, chat server, and provider). When the fleet is involved, `Amicode: Open Amicode Terminal` opens a shell whose `opencode` is the vendored, amicode-aware binary (same `OPENCODE_CONFIG_CONTENT` as the chat) — so `pnpm sync`, `bash tools/fleet/install.sh --check`, and `amico` there see the same panel you do.

---

<sub>A VS Code extension · built on [Piccolo.jl](https://github.com/harmoniqs/Piccolo.jl) · chat harness vendored from [opencode](https://github.com/sst/opencode) (MIT). Pre-release software.</sub>
