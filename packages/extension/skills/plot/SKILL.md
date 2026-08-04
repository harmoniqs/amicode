---
name: plot
description: Generate visualization code for optimization results. Uses Piccolo's native plotting API as the primary path; falls back to bespoke CairoMakie with upstream candidate tagging.
agents: [experimenter, engineer]
surface: public
scenarios: [cz-gate-seed]
---

> **Prerequisites:** Assumes `/solve` has produced a saved pulse or trajectory. Complements `/analyze` for deeper investigation.

Generate Julia plotting code for quantum optimal control results using Piccolo's visualization API.

## Usage

```
/plot tier <N> gate <G> path <file.jld2>
/plot pulse <file.jld2>
/plot robustness-sweep <results.jld2> param=<name>
/plot all-tiers gate <G>
```

The argument is: $ARGUMENTS

## Instructions

### Section 1: Design Principle

**Piccolo-native first.** Before writing any plotting code, check if Piccolo's `PiccoloMakieExt` or `PiccoloQuantumToolboxExt` has a function that covers the need. Only write bespoke CairoMakie when no Piccolo function applies -- and tag that bespoke code as an upstream candidate per Section 5.

The skill generates Julia scripts; it does not execute them. Each invocation produces a standalone `.jl` file the user can run in a Julia session with CairoMakie loaded.

---

### Section 2: Piccolo Visualization API Reference

> **Staleness guard:** Before calling any function below, verify it still exists with the expected signature by grepping `Piccolo.jl/ext/PiccoloMakieExt.jl` and `Piccolo.jl/src/visualizations/`. If signatures have changed, update this reference and note the drift.

#### Pulse Plots

From `Piccolo.Visualizations` (`quantum_objects/pulse_plots.jl`):

| Function | Signature | Description | Returns |
|----------|-----------|-------------|---------|
| `plot_pulse` | `plot_pulse(pulse::AbstractPulse; n_samples=500, labels=nothing, title=nothing, figsize=(800,400), show_knots=true, kwargs...)` | Control channels over time with knot overlay | `Figure` |
| `plot_pulse!` | `plot_pulse!(ax, pulse; n_samples=500, labels=nothing, show_knots=true, kwargs...)` | In-place variant on existing axis | Modifies `ax` |
| `plot_pulse_IQ` | `plot_pulse_IQ(pulse; n_samples=500, title=nothing, figsize=(900,600), show_knots=true)` | 4-drive IQ pairs (requires exactly 4 drives) | `Figure` |
| `plot_pulse_phases` | `plot_pulse_phases(pulse; n_samples=500, title=nothing, figsize=(900,600))` | 4-drive polar form (amplitude + phase) | `Figure` |

#### State / Unitary Plots

| Function | Signature | Description | Returns |
|----------|-----------|-------------|---------|
| `plot_state_populations` | `plot_state_populations(traj; state_name=:psi_tilde, state_indices=nothing, control_name=:u, subspace=nothing, kwargs...)` | State populations over time | `Figure` |
| `plot_unitary_populations` | `plot_unitary_populations(traj; unitary_columns=1:2, unitary_name=:U_tilde_vec, control_name=:u, kwargs...)` | Unitary column populations over time | `Figure` |
| `plot_weyl_trajectory` | `plot_weyl_trajectory(traj, output_mp4="weyl_trajectory.mp4")` | Weyl chamber trajectory for 2Q unitaries (writes MP4) | `Figure` |

#### Atom-Specific Plots

| Function | Signature | Description | Returns |
|----------|-----------|-------------|---------|
| `plot_pulse_waveforms` | `plot_pulse_waveforms(traj; control_name=:u, labels=nothing, bounds=nothing, title="", kwargs...)` | Control waveforms from trajectory | `Figure` |
| `plot_rabi_drive` | `plot_rabi_drive(traj; control_name=:u, omega_x_index=1, omega_y_index=2, title="", kwargs...)` | Rabi drive visualization ($\Omega_x$, $\Omega_y$) | `Figure` |
| `plot_gate_populations` | `plot_gate_populations(traj; unitary_name=:U_tilde_vec, columns=nothing, title="", kwargs...)` | Gate populations over time | `Figure` |
| `plot_atom_populations` | `plot_atom_populations(traj, N_atoms; unitary_name=:U_tilde_vec, initial_states=nothing, title="", kwargs...)` | Per-atom populations for multi-atom systems | `Figure` |
| `plot_fidelity_trace` | `plot_fidelity_trace(traj, U_goal; unitary_name=:U_tilde_vec, subspace=nothing, title="", kwargs...)` | Fidelity vs time along trajectory | `Figure` |

#### Rydberg Chain Plots

| Function | Signature | Description | Returns |
|----------|-----------|-------------|---------|
| `plot_rydberg_chain` | `plot_rydberg_chain(N, distance; C=862690*2pi, cutoff_order=1, populations=nothing, kwargs...)` | Static Rydberg chain layout with interaction strengths | `Figure` |
| `animate_rydberg_chain` | `animate_rydberg_chain(traj, N, distance, filename="rydberg_chain.gif"; C=862690*2pi, cutoff_order=1, state_name=:psi_tilde, framerate=30, kwargs...)` | Animated Rydberg chain (writes GIF) | `Figure` |

#### Animation Utilities

| Function | Signature | Description | Returns |
|----------|-----------|-------------|---------|
| `animate_figure` | `animate_figure(fig, frames, update_frame!; mode=:inline, fps=24, filename="animation.mp4")` | Generic animation helper | `Figure` |
| `animate_name` | `animate_name(traj, name; fps=24, mode=:inline, filename="name_animation.mp4", kwargs...)` | Animate a named trajectory component | `Figure` |

#### QuantumToolbox Extension (Fully Implemented)

From `ext/PiccoloQuantumToolboxExt.jl` -- requires `QuantumToolbox.jl`:

| Function | Signature | Description | Returns |
|----------|-----------|-------------|---------|
| `plot_bloch` | `plot_bloch(traj; index=nothing, state_name=:psi_tilde, state_type=:ket, subspace=1:2, kwargs...)` | Bloch sphere trajectory, supports ket or density matrix | `Figure` |
| `plot_bloch!` | `plot_bloch!(fig::Figure, traj, idx::Int; kwargs...)` | Update Bloch arrow at a specific index | `Figure` |
| `animate_bloch` | `animate_bloch(traj; fps=24, mode=:inline, filename="bloch_animation.mp4", kwargs...)` | Animated Bloch sphere (writes MP4) | `Figure` |
| `plot_wigner` | `plot_wigner(traj, idx; state_name=:psi_tilde, state_type=:ket, kwargs...)` | Wigner function at a specific timestep | `Figure` |
| `plot_wigner!` | `plot_wigner!(fig::Figure, traj, idx)` | Update Wigner plot at a specific index | `Figure` |
| `animate_wigner` | `animate_wigner(traj; mode=:inline, fps=24, filename="wigner_animation.mp4", kwargs...)` | Animated Wigner function (writes MP4) | `Figure` |

---

### Section 3: Standard Plot Sets Per Tier

When invoked as `/plot tier N gate G`, generate the standard set for that tier. All plots should be saved to the demo's `figures/` directory.

#### Tier 1 -- Nominal ("Does the gate work?")

| Plot | Call |
|------|------|
| Pulse shape | `plot_pulse(pulse)` or `plot_pulse_waveforms(traj)` (atom-specific) |
| State/gate populations | `plot_state_populations(traj)` or `plot_gate_populations(traj)` or `plot_unitary_populations(traj)` |
| Fidelity trace | `plot_fidelity_trace(traj, U_goal)` |

**Platform-specific additions at Tier 1:**

| Platform | Additional Plots |
|----------|-----------------|
| Bosonic / cavity | `plot_pulse_IQ(pulse)`, `plot_pulse_phases(pulse)` for 4-drive systems; `plot_wigner(traj, idx)` for cavity phase space |
| Single-qubit with leakage (3-level) | `plot_bloch(traj)` for Bloch sphere trajectory in computational subspace |
| Multi-qubit Rydberg | `plot_atom_populations(traj, N_atoms)`, `animate_rydberg_chain(traj, N, d, "output.gif")` |
| Two-qubit (transmon/silicon spin) | `plot_weyl_trajectory(traj, "weyl.mp4")` |

#### Tier 2 -- Min-Time ("Is it fast and clean?")

All of Tier 1, plus:

| Plot | Call | Notes |
|------|------|-------|
| Constraint margins | `plot_constraint_margins(traj, bounds)` | **BESPOKE** -- upstream candidate |
| Duration comparison | Bespoke bar chart of T_nominal vs T_mintime | **BESPOKE** -- upstream candidate |

#### Tier 3 -- Robustness ("Does it survive noise?")

All of Tier 1, plus:

| Plot | Call | Notes |
|------|------|-------|
| Robustness sweep | `plot_robustness_sweep(results, param_name)` | **BESPOKE** -- upstream candidate |
| Worst-case overlay | Nominal vs worst-case pulse/populations overlay | **BESPOKE** |

#### Tier 4 -- Hardware ("Does it work on the device?")

| Plot | Call | Notes |
|------|------|-------|
| Convergence curve | `plot_convergence(ipopt_log_path)` | **BESPOKE** -- upstream candidate |
| Sim-vs-real gap | Evolution of the model-experiment discrepancy across calibration rounds | **BESPOKE** |
| Measurement residuals | Per-observable residuals over calibration rounds | **BESPOKE** |

---

### Section 4: Analysis Plots (Bespoke When Needed)

These analysis plots do not yet have Piccolo equivalents. Each is a candidate for upstreaming to `PiccoloMakieExt`:

| Plot | Purpose | Suggested Piccolo Function |
|------|---------|---------------------------|
| Convergence curve | Parse Ipopt log, plot infidelity vs iteration | `plot_convergence(ipopt_log_path)` |
| Pareto frontier | Fidelity vs duration across multiple mintime runs | `plot_pareto(results::Vector)` |
| Constraint margins | Amplitude/slew headroom as shaded bands | `plot_constraint_margins(traj, bounds)` |
| Robustness sweep | Fidelity under error parameter sweep | `plot_robustness_sweep(results, param_name)` |

When writing any of these bespoke plots, follow the Upstream Candidate Protocol in Section 5.

---

### Section 5: Upstream Candidate Protocol

This protocol applies to ALL bespoke code written in demos -- plotting functions, system constructors, constraint helpers, save/load utilities. Any reusable code that is not covered by the Piccolo API is an upstream candidate.

When writing bespoke plotting code that does not use the Piccolo API:

1. **Write the code** to the demo's `src/plotting.jl` (or the relevant `src/*.jl` module).

2. **Create a vault insight note** at `<vault>/insights/insight-YYYYMMDD-HHMMSS-upstream-candidate-{function_name}.md` (route per amico-vault):

   ```yaml
   ---
   type: insight
   date: YYYY-MM-DD
   source: plot-skill
   evidence: ["[[{demo-name}]]"]
   confidence: low
   tags: [upstream, plotting, {platform}]
   ---
   ```

   Body must include:
   - **Function name**: e.g., `plot_convergence`
   - **Purpose**: one-line description
   - **Signature**: proposed Julia signature with keyword args
   - **Suggested Piccolo module**: `PiccoloMakieExt` or `Piccolo.Visualizations.Analysis`
   - **Dependencies**: CairoMakie, and any data-parsing dependencies
   - **Current locations**: which demo files have this plot today
   - **Blockers to upstreaming**: any (e.g., "depends on Ipopt log format which may be solver-specific")

3. **Pattern detection**: When `dream:synthesize` detects the same upstream candidate in 2+ independent demos, it promotes the candidate to `upstream-confirmed` and generates an engineering brief. See the `/dream-synthesize` skill for the upstream audit step.

---

### Section 6: Invocation Examples

```
/plot tier 1 gate CZ path data/01_nominal/CZ.jld2
```
Generates a Julia script with `plot_pulse`, `plot_gate_populations`, and `plot_fidelity_trace` calls for the CZ gate at Tier 1.

```
/plot pulse data/02_mintime/CZ.jld2
```
Generates a standalone pulse visualization script.

```
/plot robustness-sweep results.jld2 param=detuning
```
Generates a bespoke robustness sweep plot (tagged as upstream candidate).

```
/plot all-tiers gate CZ
```
Generates the full standard plot set for all available tiers of the CZ gate, scanning for saved results in `data/01_nominal/`, `data/02_mintime/`, `data/03_robustness/`, `data/04_hardware/`.

Each invocation generates a Julia `.jl` script the user can run -- the agent does not execute CairoMakie itself.

---

### Section 7: Performance Note

CairoMakie is heavyweight (~10s load time). This skill generates scripts; it does not run them. For unattended agent runs (demo tier completion), plot generation is a separate Julia invocation per gate per tier. Budget ~3-4 minutes of Makie overhead for a 5-gate demo through 4 tiers (20 plot invocations).

To minimize overhead in interactive sessions, load CairoMakie once and run multiple plot calls in the same Julia session:

```julia
using CairoMakie
using Piccolo

# Load once, plot many
pulse, meta = load_pulse("data/01_nominal/CZ.jld2")
fig1 = plot_pulse(pulse)
save("figures/CZ_pulse.png", fig1)

fig2 = plot_fidelity_trace(traj, U_goal)
save("figures/CZ_fidelity.png", fig2)
```
