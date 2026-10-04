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
