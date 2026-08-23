---
name: design-a-pulse
description: Walk a user through designing an optimized quantum control pulse — platform selection, system model, problem formulation, solve, and inspection. Invoke when the user asks to design a pulse, optimize a gate, or prepare a quantum state.
agents: [researcher, experimenter]
surface: public
---

# Design a Pulse — Guided Interview

Use this skill when the user asks to design, optimize, or synthesize a quantum
control pulse (gate or state-prep). This is the orchestration layer — it tells
you which stages to walk through and which platform skills to invoke for the
physics.

## When to invoke

- User says "design a pulse", "optimize a gate", "X gate on transmon", etc.
- User selects "Design a new pulse" from the onset router
- User asks for state preparation (cat state, GKP, Fock state)

## Protocol

**ONE question at a time.** Ask, wait, record, advance. Use the `question` tool
for all choices (default option first with "(Recommended)"); free-form values
use `kind: "text"`. Never batch questions.

**Anchor on recorded state:** if the user has a profile with platform info or
recent problems, use that context — don't re-ask what you already know.

## Stages (in order)

### 1. Platform

Ask: "What kind of system are you working with?" via `question` tool.
Options: transmon (recommended) | neutral-atom Rydberg | cavity / bosonic | other

Record via `amicode_pick_system`. Then **invoke the matching platform skill**
from the Skill index (`transmon`, `atoms`, `bosonic`, `fluxonium`, `ions`) for
the physics — Hamiltonian, drive structure, typical parameters. If no skill
matches, offer free-tier authoring (public packages, unvetted, re-rollout-verified).

### 2. Model (System)

Structure-first: how many components, homogeneous?, topology if multi-qubit,
drive architecture. Then batch the mechanical params (levels, drive_max, omega/delta).

- **Transmon:** 3 levels default (4 for leakage realism; avoid 5+)
- **Cavity/bosonic:** Fock cutoff sized to target state (invoke `bosonic` skill)
- **Multi-component:** record via `amicode_set_model` with components + couplings

Convention: `T` = gate time (ns), `N` = timesteps. Never conflate.

### 3. Mode

Simulate first, or straight to solve? Warm start from a banked pulse or cold start?

If warm-starting: `traj = load_traj("path/to/pulse.jld2")` as the initial guess.
Prefer the user's pulse bank — check recent problems for a matching target.

### 4. Problem (Target)

Two types, both first-class:
- **Gate synthesis** — target is a unitary (X, Y, Z, H, CZ, etc.)
- **State preparation** — target is a state (cat, Fock, GKP); uses `KetTrajectory`

Record via the appropriate `amicode_*` tool.

### 5. Formulation

Record as typed facets via `amicode_formulate`:
- Trajectory type (gate | state-prep | open-system)
- Time mode (fixed | min-time)
- Parameterization (smooth | spline | bang-bang)
- Free-phase flag (for entangling gates)
- Leakage suppression flag

The infidelity objective is DERIVED from the type — don't set it manually.

### 6. Solve

Defaults: T = 10 ns, N = 50, max_iter = 60 (scale N with T: ~5-10 steps/ns).

Then follow the **## Workflow** section in the main AGENTS.md:
1. `amico-run resolve` to get the tier
2. Author `solve.jl` per the tier
3. Assemble `solvespec.json`
4. Launch via `amico-run --spec` (detached)

Tell the user: "Solve launched — watch the Run Inspector."

### 7. Inspect

The Run Inspector streams iterations automatically. After `FINISHED`, report
the fidelity from `result.toml`.

### 8. Hardware (optional)

Guided stubs: explain the send-to-device gate and calibration loop. Record
interest via `amicode_to_hardware` / `amicode_calibrate` (bookkeeping only —
no device I/O in this build).

## Key references

- Platform skills: `transmon`, `atoms`, `bosonic`, `fluxonium`, `ions`
- Problem types: invoke the `problem-types` skill for trajectory/parameterization guidance
- Setup patterns: invoke the `setup` skill for Piccolo problem construction
- Warm starts: invoke the `warm-start` skill for seeding decisions
- Constraints: invoke the `constraints` skill for bounds and penalties
- Solving: invoke the `solve` skill for Julia execution flags
