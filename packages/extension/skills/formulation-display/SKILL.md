---
name: formulation-display
description: Present an optimization problem in classic form — the papers' notation (Direct Collocation for Quantum Optimal Control, arXiv:2305.03261; Universal Dynamics with Globally Controlled Analog Quantum Simulators, arXiv:2508.19075): continuous core, direct collocation, indirect/GRAPE contrast, free-time/min-time, robustness ensembles, plus the per-solve display set. Use when writing a problem statement for a PI-report finding, demo, paper, or spec, or when a report/paper must show what was actually solved.
agents: [researcher, experimenter, engineer]
surface: public
scenarios: [pi-report-findings, demo-writeup, paper-section, spec-cards]
---

# Formulation display — the problem in classic optimization form

House style, from the two papers: whenever a solve is described beyond a
headline number, the optimization problem itself is **written out** —
objective, constraints, dynamics — in the papers' notation. The
direct-collocation paper (arXiv:2305.03261) is the canonical source for the
DIRCOL forms; the global-control paper's Appendix G (arXiv:2508.19075) is
the canonical source for the continuous core and the direct/indirect
contrast. Equation pointers below cite those sources.

The LaTeX idiom for all forms (the papers' `split` layout):

```latex
\begin{split}
\underset{<variables>}{\text{minimize}}\quad & <objective> \\
\text{subject to}\quad & <dynamics constraints> \\
                       & <boundary conditions> \\
                       & <bounds>
\end{split}
```

## Form 1 — the continuous core

Source: arXiv:2508.19075, App. G, Eq. (111). Over time-dependent state and
control trajectories:

$$\min_{x(t),u(t)} \int_0^T \ell(x(t),u(t))\,dt + \ell_T(x(T))
\quad \text{s.t.} \quad \dot{x}(t) = f(x(t),u(t),t),\; x(0)=x_\mathrm{init}$$

with the quantum Hamiltonian written in the affine control form
(arXiv:2305.03261, Eq. (2)):

$$H(\mathbf{a}(t)) := H_0 + \sum_i a_i(t)\,H_i$$

Show this form when introducing a problem class or writing for an audience
that thinks in continuous time; it is the parent of every discrete form
below.

## Form 2 — direct collocation (the house default)

Source: arXiv:2305.03261, Eqs. (9), (10), (11). States and controls are
decision variables jointly; dynamics are enforced as **equality constraints**
between knots:

$$\begin{split}
\underset{z_{1:N}}{\text{minimize}}\quad & J(z_{1:N}) \\
\text{subject to}\quad & f(z_k, z_{k+1}) = 0 \quad \text{(collocation, e.g. Pad\'e-integrator: } U_{k+1} - e^{-iH(\mathbf{a}_k)\Delta t}U_k\text{)} \\
& U_1 = I_{2n} \\
& |\mathbf{a}_k| \le \mathbf{a}_{\max}
\end{split}$$

with $z_k$ packing states and controls per knot. Two load-bearing practical
notes from the paper, both worth stating when the form appears:

- **Isomorphic representation.** Complex objects enter the real-valued NLP
  via the isomorphism (reals-then-imaginary parts); the paper's tilde
  notation ($\widetilde{U}$, $\mathrm{iso}(\cdot)$) is the house notation.
- **Solver.** A large, sparse nonlinear program solved by an interior-point
  solver (IPOPT); dynamically infeasible initial guesses are legitimate
  starting points and often converge fast — a defining property of direct
  methods.

Show this form for essentially every Piccolo solve, spec card, or report
finding that formulates a new problem.

## Form 3 — indirect (GRAPE) contrast

Source: arXiv:2508.19075, Eqs. (114)–(115). Optimize over controls only;
states are retrieved by propagation:

$$\underset{u_{1:N-1}}{\text{minimize}} \sum_{k=1}^{N-1} \ell(x_k(u_{1:k-1}),u_k) + \ell_T(x_N)
\quad \text{s.t.} \quad |u(t)| \le u_{\max}$$

Show this form **only as a contrast**: fewer variables, but every
$x_k$-involving gradient must propagate dependence through the dynamics —
intermediate-state constraints are hard to enforce and the control landscape
is rough. The papers use it to justify the direct method; a report should
do the same, not present it as a competing option we run.

## Form 4 — free-time / minimum-time

Source: arXiv:2305.03261, Eq. (22) and its warm-start continuation. Stage
one solves a free-time problem (knot times $\Delta t_k$ are decision
variables) for a regularized objective:

$$\begin{split}
\underset{z_{1:N}}{\text{minimize}}\quad & J_0 = Q\,\ell(\widetilde{U}_N) + R(\mathbf{a}_{1:N-1}) \\
\text{subject to}\quad & \mathbf{P}^{(4)}(\widetilde{U}_{k+1},\widetilde{U}_k,\mathbf{a}_k,\Delta t_k) = 0 \\
& \widetilde{U}_1 = I_{2n}, \quad |\mathbf{a}_k| \le \mathbf{a}_{\max}
\end{split}$$

Stage two warm-starts a time-minimizing objective
$J = J_0 + D\sum_k \Delta t_k$ with a final-fidelity floor
$\mathcal{F}(U_N) \ge \bar{\mathcal{F}}$ preventing the duration term from
trading away the gate. **Always state the floor's relation to the achieved
stage-one fidelity** — a floor at or above the achieved value is a
guaranteed violation (a recorded lesson from the OQC campaign: set floors
*below* achieved F with margin).

## Form 5 — robustness ensembles

House form for `SamplingProblem`: minimize a weighted sum (or the worst
case) over an ensemble of perturbed systems:

$$\underset{z}{\text{minimize}} \sum_j w_j\, J(z;\theta_j)
\quad \text{s.t.} \quad \text{(per-member dynamics)},$$

with $\theta_j$ the perturbation ensemble (drive scale, detuning, position
jitter). When reporting: **nominal and worst-case are both stated, legs
named** — the display-conventions honesty bar.

## The per-solve display set

What accompanies a stated problem, composing the plot skill's per-tier
standards (never duplicating them):

| Solve type | Always show |
| --- | --- |
| Gate / state synthesis | The stated form; pulse plot; populations or unitary-distance trace; convergence trace ($J$, $\texttt{inf\_pr}$, $\texttt{inf\_du}$) |
| Free-time / min-time | The stated form **plus** the duration/fidelity trajectory and the floor margin |
| Robustness ensemble | Nominal + worst-case, members overlaid; the per-member breakdown table |
| Any free-phase solve | The virtual-Z frame note — which phases were free and their optimized values |

## The component inventory — full disclosure

The user is fully informed: a stated problem lets the reader reconstruct
the NLP. Every formulation statement names the **trajectory type,
integrator (with its core), every objective term with its weight, every
constraint with its bound, and the solver**. The tables below map API to
classic form. Every name is verified against package source; the classic
forms follow the papers' notation.

### Integrators (the dynamics constraint each one enforces)

| Integrator | Form it enforces | Notes |
| --- | --- | --- |
| `HermitianExponentialIntegrator` (unitary / ket / multiket / sampling variants) | $U_{k+1} = e^{-iH(\mathbf{a}_k)\Delta t} U_k$ | The step's exponential evaluates via an internal Padé-13 approximation (source: `integrators_exponential/_exponential_integrators.jl`). The published Padé-integrator collocation form is the paper's $P^{(4)}$ (arXiv:2305.03261 §III-B) |
| `NonhermitianExponentialIntegrator` (density / multidensity) | $\rho_{k+1} = e^{\mathcal{L}(\mathbf{a}_k)\Delta t}\rho_k$, $\mathcal{L}(\cdot) = -i[H,\cdot] + \text{dissipation}$ | Daleckii–Krein for the Fréchet derivative (`daleckii_krein.jl`) |
| `BilinearIntegrator` | Piecewise-constant control, first-order | The simplest collocation step |
| `SplineIntegrator` (Piccolo) | The constraint integrates the **exact spline waveform** reconstructed from knot values — the emitted pulse and the optimized pulse are the same object | Per trajectory type (unitary/ket/multiket/density/multidensity) |
| Piccolissimo `SplineIntegrator` cores | Magnus series: `MagnusGL4Alg`, `MagnusAdapt4Alg`; `ChebyshevAlg` (ket); Duhamel for density (`density_duhamel.jl`) | State which core ran — they are different approximations, and "Magnus does not apply to the dissipative density ODE (non-skew rhs)" is a recorded lesson |
| `SplitOperatorIntegrator` (Piccolissimo) | Strang split-step, matrix-free: kinetic factor $e^{-ik^2\Delta t/2m}$ (control-independent) + potential kicks; analytic JVP/VJP, no AD near the FFT | Atom-transport venue (issue #270) |
| Tsit5 (explicit RK) | Adaptive rollout only | **Never** a collocation constraint; verification/rollout path — quote its agreement separately (density paths are Tsit5-primary + Tsit5-cross-check: weaker integrator independence, a recorded honesty note) |

### Objective terms

| Term | Classic form | Source |
| --- | --- | --- |
| `UnitaryInfidelityObjective` | $\ell(U) = 1 - \frac{1}{n}\lvert\mathrm{tr}(U_\text{goal}^\dagger U)\rvert$ | Paper Eq. (3), arXiv:2305.03261 |
| `KetInfidelityObjective` | $1 - \lvert\langle\psi_\text{goal}\vert\psi_N\rangle^2\rvert$ | `objectives.jl` |
| Free-phase variants (`UnitaryFreePhaseInfidelityObjective`, `KetFreePhase...`, `CoherentKetFreePhase...`) | Gate infidelity over the computational subspace **up to free per-component virtual-Z phases** — objective-only; the frame is exact software, never a cheat | `objectives.jl`; the free-phase-decisiveness convention |
| `DensityMatrixInfidelityObjective` | $1 - \mathrm{tr}(\rho_\text{goal}\rho_N)$ (Hilbert–Schmidt) | `objectives.jl` |
| `LeakageObjective` | $\lVert(I - \Pi)\psi_k\rVert^2$ at knot points | `objectives.jl` |
| `QuadraticRegularizer` | $R = \sum_k r\lVert\mathbf{a}_k\rVert^2$ | `docs_cache.jl` usage |
| Minimum-time term | $D\sum_k \Delta t_k$ | Paper Eq. (22) continuation |
| Piccolissimo regularizers (`HermiteBendingEnergyRegularizer`, `HermiteC2Regularizer`) | Bending energy $\int\lvert u''\rvert^2$ and C² forms on the spline | `objectives/hermite_bending_energy_regularizer.jl` |
| Adjoint robustness / `UnitarySensitivityObjective` | First-order infidelity response $\lvert\partial J/\partial\theta\rvert$ to Hamiltonian-parameter perturbations, via adjoints (no finite differences) | `objectives_robustness/`; Piccolissimo reexports |
| Channel process infidelity (Piccolissimo) | $F_\mathrm{pro}$ exact vs Choi, linear coordinates + HS-dual $\tau_k$ | `objectives/channel_process_infidelity.jl` |
| `MeasurementMatchingObjective` (Intonatissimo) | $\lVert y(z) - y_\text{target}\rVert^2_{Q_\text{meas}}$ | The intonatissimo card's display section |

### Constraints

| Constraint | Classic form | Where it lives |
| --- | --- | --- |
| Control amplitude bounds | $\lvert a_i(t)\rvert \le a_{i,\max}$ | The z-vector's bound layer (never a nonlinear row) |
| Slew / interior overshoot (`CubicSplineBoundConstraint`, `du_bound`) | The **emitted spline** stays within bounds between knots — the knot values alone do not guarantee it | `constraints_spline/`; the knots-vs-emitted distinction is load-bearing |
| Leakage bound (`KnotPointConstraint` / `NonlinearKnotPointConstraint`) | $\lVert(I-\Pi)\psi(t_k)\rVert^2 \le \varepsilon$ at knots | `constraints.jl` |
| `FinalUnitaryFidelityConstraint` | $\mathcal{F}(U_N) \ge \bar{\mathcal{F}}$ | `templates/minimum_time_problem.jl` |
| `DurationConstraint` | $\sum_k \Delta t_k \le T_{\max}$ (or per-interval $\Delta t$ bounds) | `templates/`; per-interval floors encode physics (settling, clock) |
| QILC trust region | $\lVert u - u_\text{ref}\rVert^2_{R_\text{tr}}$ recentered on $z_\text{ref}$ each iteration | The intonatissimo card |

### Solvers

| Solver | What it is | When stated |
| --- | --- | --- |
| IPOPT (via DirectTrajOpt) | Interior-point, exact sparse NLP | Every Piccolo solve; `exact_hessian=false` on MultiKet is a recorded caveat |
| Altissimo (Piccolissimo) | Matrix-free interior-point; callback fields $f_\text{val}$, $eq\_viol$, $kkt\_error$ are the honest convergence line | Piccolissimo solves |
| Gauss–Newton second-order mode | Matrix-free HVP composition | When Piccolissimo's GN default runs |
| Armijo backtracking (ILC) | Accept/reject on objective descent; show accepted **and** rejected steps | QILC convergence displays |

**Completeness rule.** A formulation statement that omits any row the
problem actually used is incomplete — the reader must be able to
reconstruct the NLP from the statement plus the run dir. When a component
is not in these tables (a new upstream constructor, an inline constraint),
state its form from source and mark it `unverified` until smoked.

## Where these render

- **PI-report findings** (`pi-report` fill contract, amicode #1700): a
  finding that formulates a new problem carries its classic form inline;
  findings that reuse an established formulation name it and cite the spec.
- **Demo/paper write-ups**: the form opens the methods section; the
  run-dir artifacts back every number (display-conventions: a number
  without an artifact is a claim).
- **Spec cards**: the falsifiable acceptance entries pair with the formal
  statement — state the problem, then the gates that adjudicate it.

## Honesty bars (inherit `display-conventions`)

- Legs named, never merged; the researcher's notation; provenance stamps.
- Package-API terms are **mapped to math** here — the report shows math,
  the run dir shows code. When mapping, cite the package's own docstring
  or verified usage card (never invent an equation the package doesn't
  solve — the anti-gaming rule applies to formulations too).
