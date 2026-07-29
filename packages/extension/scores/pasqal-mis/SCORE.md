---
type: score
schema_version: 1
id: pasqal-mis
version: 1
derived_from: null
name: "Solve a graph problem on a Pasqal atom array"
outcome: "An optimized adiabatic waveform solving YOUR graph's MIS, validated on an emulator"
audience: [algorithms, ml, no-physics-assumed]
duration_estimate: "60–90 min"
device: {backend: pasqal, qpu_runnable: true, emulators: [emu-mps]}
entitlements: [pasqal-hackathon-2026]
stages:
  - id: application
    emits: [circuit]
    questions:
      - id: graph_source
        prompt: "Which graph should we solve? I have a ready-made 4-atom demo graph, or bring your own edge list / positions."
        choices: ["demo graph (4 atoms, star)", "my own graph"]
        default: "demo graph (4 atoms, star)"
      - id: graph_size
        prompt: "How many vertices? (Local solves are comfortable up to ~8 atoms; larger instances want the cloud solver.)"
        default: "4"
        skip_if: "graph_source == demo graph (4 atoms, star)"
  - id: register
    emits: [system]
    questions:
      - id: spacing
        prompt: "Atom spacing (μm)? This sets which vertices are neighbors — two atoms closer than the blockade radius share an edge."
        default: "9 μm nearest-neighbor spacing, ~10 μm blockade radius"
        memory_hooks: [unit-disk-blockade]
  - id: formulate
    emits: [formulation]
    questions:
      - id: schedule
        prompt: "Waveform strategy — optimize the sweep, or run the textbook adiabatic ramp as a baseline first?"
        choices: ["optimized sweep", "textbook ramp baseline"]
        default: "optimized sweep"
      - id: solve_params
        prompt: "Sweep duration T (μs), timesteps N, and max_iter?"
        default: "T = 6.0 μs, N = 300, max_iter = 100"
  - id: solve
    emits: [run, pulse]
    executor: local
    template: templates/solve.jl
  - id: validate
  - id: device-sim
    emits: [device_session]
    backend: emu-mps
    gate: light
    template: templates/register.py
    optional: true
  - id: device-qpu
    emits: [device_session]
    backend: fresnel
    gate: heavy
    optional: true
---

You are running the **pasqal-mis** score: from a graph to an optimized neutral-atom
waveform that solves its **Maximum Independent Set**, then onto a Pasqal emulator (and,
when hardware access is wired, the Fresnel QPU).

**Audience: no physics assumed.** The user is likely an algorithms/ML person. Explain
each stage in graph language first, physics second. One question at a time, via the
native `question` tool for anything with options — same interview contract as always.

**The story you are telling** (say it in your own words, staged, never as a lecture):
each graph vertex becomes an atom; the laser can excite an atom to a Rydberg state;
two nearby excited atoms pay a huge energy penalty (the *blockade*) — so the
lowest-energy configuration excites as many mutually non-adjacent atoms as possible.
That is exactly the Maximum Independent Set. We sweep the laser parameters
$\Omega(t)$ (coupling) and $\delta(t)$ (detuning) so the atoms end in that
lowest-energy state, and *optimizing the sweep* gets there faster and more reliably
than the textbook ramp.

Per-stage notes:

1. **application** — record the graph as the Circuit/Algorithm entity (its *algorithm*
   facet: a problem instance, not a gate list). The demo graph is a 4-atom star
   (center + 3 leaves): its unique MIS is the three leaves — easy to verify by eye,
   nontrivial for the hardware (the center must stay unexcited). For "my own graph",
   accept an edge list or 2D positions; unit-disk realizability is checked at
   **register**. Keep local instances ≤ ~8 vertices (state dimension is $2^n$, and
   the timestep count must grow with the energy scales — the template says how);
   larger graphs are the cloud solver's job — record the interest, stay honest that
   this build solves locally.

2. **register** — geometry IS the graph: atoms closer than the blockade radius
   $R_b$ are edges. Confirm spacing; for uploaded graphs, embed positions so that
   edge ⇔ distance < $R_b$ (for non-unit-disk graphs say so and offer the demo
   instead — never silently drop edges). Record the System via `amicode_set_model`:
   positions, $C_6$, $\Omega_{\max}$, detuning range.

3. **formulate** — objective: maximize the probability of measuring the MIS
   configuration at the end of the sweep (ket infidelity to the MIS-encoding state —
   computed classically for these sizes, so validation is airtight). The **textbook
   ramp baseline** is also the warm start for the optimized sweep: $\Omega$ ramps up
   and back down, $\delta$ sweeps negative → positive. Constraints are the hardware's:
   $\Omega \in [0, \Omega_{\max}]$, $\delta$ within channel bounds, waveform slew
   limits. Record via `amicode_formulate`.

4. **solve** — author `templates/solve.jl` (the vetted MIS template: fill the
   `# FILL IN` block from the recorded entities) and launch through the tiered gate
   per the solve workflow. Executor is **local** in this build; the same SolveSpec
   flips to the GPU cloud solver (Altissimo) when that backend lands — mention it as
   "for bigger graphs" and move on.

5. **validate** — three checks, all mechanical: (a) the target bitstring is a true
   MIS (the template brute-forces the graph and asserts it); (b) independent
   re-rollout of the saved pulse reproduces the reported probability; (c) report
   $P(\text{MIS})$ — for the demo graph anything ≥ 0.9 is a strong result; the
   textbook ramp at the same duration is the honest comparison. Never report the
   optimizer's number without (b).

6. **device-sim** 🔒 *light gate* — checks before entering: validate passed with
   verified $P(\text{MIS})$, and the waveforms respect the recorded channel bounds.
   The solve stage wrote `waveforms.json` (times, $\Omega$, $\delta$, positions) —
   `templates/register.py` turns it into a **Pulser** register + sequence and runs a
   local emulator if `pulser` is installed (`pip install pulser`), printing sampled
   bitstring counts. If Pulser is not installed, hand the user the script and the
   one-line install — the artifact is theirs either way. Pasqal **Cloud** submission
   (EMU-MPS) needs API credentials — not wired in this build; say so plainly.

7. **device-qpu** 🔒 *heavy gate* — real QPU minutes (Fresnel). Not wired in this
   build: explain the gate (hardware bounds, discretization, shot budget, human
   sign-off), record interest via `amicode_to_hardware`, and stop. Never imply a
   submission happened.

**Off-path recovery:** "can it go faster?" → shorten $T$ and re-optimize warm-started
from the current pulse (that is the min-time move). "why isn't the probability 1?" →
adiabaticity vs duration, and show the ramp-vs-optimized comparison. "bigger graph?" →
cloud solver interest, recorded honestly. Anything else off the rail: answer, then
offer to resume at the stage cursor — never force the rail.
