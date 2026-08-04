# Demo — Documentation conventions

Every demo ships a `README.md` and four docs under `docs/`. This reference gives the required
structure for each. Loaded on demand from [`../SKILL.md`](../SKILL.md).

Every demo includes a `README.md` and four docs under `docs/`. These serve different
audiences:

| File | Purpose | Audience |
|------|---------|----------|
| `README.md` | Executive summary, highlights table, getting started | First-time reader |
| `docs/system_model.md` | Physics foundation (Hamiltonian, parameters, basis/drive choices) | "Why does this system behave this way?" |
| `docs/optimization_guide.md` | Practical workflow (pseudocode, constraints, tuning, solver settings) | "How do I optimize?" |
| `docs/results_summary.md` | Comprehensive results tables, ablation studies, key findings | "What did we achieve?" |
| `docs/future_directions.md` | Research extensions, open problems | "What comes next?" |

**No overlap**: README links to docs/ for details; docs/ files are self-contained technical
references.

Optionally, a `docs/problem-details/` subdirectory can hold deep-dive documents on specific
NLP formulations (e.g., `cz_3level_nlp.md` documenting the free-phase CZ problem, blockade
regime analysis, weight tuning, and comparison to theoretical speed limits).

## `README.md`

Structure:
1. **Highlights table** — gate fidelities, durations, compression ratios (the headline numbers)
2. **Central theme paragraph** — one paragraph on what makes this demo interesting
3. **Folder structure** — annotated tree of `src/`, `scripts/`, `data/`, `docs/`
4. **Getting Started** — three options: run from scratch, warm-start from saved data, run tests
5. **Key Findings** — numbered physics/optimization insights
6. **Documentation** — links to all `docs/` files
7. **Hardware Parameters** — code example showing how to customize system parameters

## `docs/system_model.md`

Structure:
1. **Hamiltonian** — full equation with operator definitions
2. **Physical Parameters** — table with symbol, value, units for all hardware constants
3. **Operating regime justification** — why this parameter regime matters (e.g., "blockade regime V_nn/Ω_max ≈ 0.8", "half-flux sweet spot for parity protection", "Lamb-Dicke regime η ≪ 1")
4. **System configurations** — table comparing available system types (e.g., GlobalRydberg vs LocalDetune vs ZonedDetune)
5. **Hilbert space** — dimension table by qubit count
6. **Drive channels** — table of controllable operators, bounds, and physical motivation
7. **Pulse parameterization** — spline type, knot count, constraints, and why

Use $\hbar = 1$, energies/frequencies in GHz or MHz, gates in uppercase (X, H, CZ), operators
with hats.

## `docs/optimization_guide.md`

Structure:
1. **Core Workflow** — 6-step pseudocode (build system → build pulse → build trajectory → build integrator → build problem → solve)
2. **Why [key design choice]** — justify the main technical choice (e.g., MagnusAdapt4 for unitarity, MultiKetTrajectory for DOF reduction)
3. **Pulse Parameterization** — knot count table, initialization, scale
4. **Constraints** — amplitude bounds, slew rate, boundary conditions, timestep bounds (with physical motivation for each)
5. **Objective Function** — J = Q·I + R_u||u||² + R_du||u̇||² with tuning tips table
6. **Minimum-Time Optimization** — MinimumTimeProblem wrapping, floor constraint
7. **Solve Strategy** — cold start (L-BFGS→Hessian→L-BFGS→Hessian) vs warm start, iteration counts
8. **Choosing System/Basis/Drive** — comparison table with recommendations
9. **Monitoring Convergence** — how to read Ipopt output
10. **Saving/Loading** — load_pulse() usage and metadata keys

## `docs/results_summary.md`

Structure:
1. **Hardware Constraints** — parameter table (repeated from system_model for self-containedness)
2. **Results by qubit count** — separate sections for 1Q, 2Q, 3Q gates, each with a table: Gate | Fidelity | Duration | Config | Notes
3. **Min-time results** — table with initial T, final T, compression ratio
4. **Ablation studies** — basis comparisons, knot count sweeps, system config comparisons (with measured fidelity gaps)
5. **Key Findings** — numbered physics insights from the results (e.g., "L-BFGS escapes local minima that exact Hessian cannot", "phase drive is 60x stronger at half-flux")

## `docs/future_directions.md`

Structure (organized by research theme):
1. **Scaling / Many-body** — higher qubit counts, dimension growth
2. **Gate compilation** — multi-gate pulses, subcircuit primitives
3. **Variable optimization** — global parameters (atom spacing, flux point, trap frequencies)
4. **Knot resolution study** — systematic sweep, adaptive refinement
5. **Open systems** — decoherence channels relevant to this platform
6. **Robustness** — error channels, robust control extensions
7. **Hardware-in-loop** — calibration integration (platform-dependent)

Each section should include open questions and concrete next steps, not just vague
aspirations.
