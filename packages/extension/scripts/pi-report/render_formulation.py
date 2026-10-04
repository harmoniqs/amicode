"""Render the classic-form problem statement from a run's formulation.toml.

The formulation record is the truth about what was solved (amicode #1700,
the formulation-record spec): for spec-built problems it is the retained
ProblemSpec (extract_spec, verified against the object upstream); for
hand-built problems it is the upstream best-effort spec with
``canonical = false``. The renderer turns the record into the LaTeX
classic-form block per the formulation-display skill's forms — zero agent
invention in the math block. Agent prose surrounds it; the gate checks the
prose's component references against the record.

Usage:
    python render_formulation.py <formulation.toml>       # prints the LaTeX block

Or as a library: ``render_block(record: dict) -> str``.
"""
from __future__ import annotations

import hashlib
import sys
import tomllib
from pathlib import Path

_INTEGRATOR_FORMS = {
    "bilinear": r"$U_{k+1} = A(\mathbf{a}_k)\,U_k$ (piecewise-constant, first-order)",
    "hermitian_exponential": r"$U_{k+1} = e^{-iH(\mathbf{a}_k)\Delta t}\,U_k$ (Pad\'e-13 internal step evaluation)",
    "nonhermitian_exponential": r"$\rho_{k+1} = e^{\mathcal{L}(\mathbf{a}_k)\Delta t}\rho_k$, $\mathcal{L}(\cdot) = -i[H,\cdot] + \text{diss.}$ (Daleckii--Krein derivative)",
    "spline": r"spline-faithful: the constraint integrates the exact spline waveform reconstructed from knot values",
}


def _fmt(x: object) -> str:
    return str(x).replace("_", r"\_")


def _weight_terms(problem: dict) -> list[str]:
    """Regularizer/objective weights actually present — never invented."""
    terms = []
    for key, label in (
        ("Q", r"$Q\,\ell(\widetilde{U}_N)$"),
        ("R", r"$R\,\lVert\mathbf{a}\rVert^2$"),
        ("R_u", r"$R_u\,\lVert u\rVert^2$"),
        ("R_du", r"$R_{du}\,\lVert \mathrm{d}u\rVert^2$"),
        ("R_ddu", r"$R_{ddu}\,\lVert \mathrm{d}^2u\rVert^2$"),
    ):
        if key in problem:
            terms.append(f"{label} with {key} = {problem[key]}")
    if "objectives" in problem:
        terms.append(_fmt(str(problem["objectives"])))
    return terms


def _bound_terms(problem: dict) -> list[str]:
    bounds = []
    if "du_bound" in problem:
        bounds.append(r"$\lVert\mathrm{d}u\rVert \le " + str(problem["du_bound"]) + "$")
    if "ddu_bound" in problem:
        bounds.append(r"$\lVert\mathrm{d}^2u\rVert \le " + str(problem["ddu_bound"]) + "$")
    if "global_bounds" in problem:
        bounds.append(_fmt(f"global bounds: {problem['global_bounds']}"))
    return bounds


def _cap_matrix(m: object) -> str:
    """The trust obligation: never inline full Hamiltonians into run-synced
    records — digest + dims only; the full matrices live in the spec/script."""
    import json

    dump = json.dumps(m, sort_keys=True, default=str)
    digest = hashlib.sha256(dump.encode()).hexdigest()[:12]
    if isinstance(m, list):
        dims = f"{len(m)} rows"
        if m and isinstance(m[0], list):
            dims += f" x {len(m[0])} cols"
        return f"inline matrix ({dims}, sha256:{digest})"
    return f"inline ({digest})"


def render_block(record: dict) -> str:
    """The classic-form block, generated from the record. Every line either
    comes from the record or is a fixed furniture string — no invented
    component."""
    if not record:
        return (
            r"\emph{UNBACKED --- no formulation record in the run dir. "
            "Any stated formulation is unbacked; emit formulation.toml from "
            "the solve (extract_spec + solver actuals) and re-render.}"
        )
    integrator = record.get("integrator", {})
    problem = record.get("problem", {})
    solver = record.get("solver_actuals", record.get("solver", {}))
    system = record.get("system", {})
    goal = record.get("goal", {})
    wrappers = record.get("wrappers", [])
    canonical = record.get("canonical", True)

    lines: list[str] = []
    if not canonical:
        lines.append(
            r"\emph{Non-canonical record} (hand-built problem; best-effort "
            "extraction): the system and goal are raw inlines, and the solver "
            "block below is the call-site actuals, not a verified round-trip."
        )
        lines.append("")

    lines.append(r"\begin{split}")
    traj = record.get("trajectory", {}).get("kind", "unknown")
    lines.append(
        r"\underset{z_{1:N}}{\text{minimize}}\quad & "
        + (r" + ".join(_weight_terms(problem)) if _weight_terms(problem) else r"\ell(\widetilde{U}_N)")
    )
    lines.append(r"\text{subject to}\quad & " + _INTEGRATOR_FORMS.get(integrator.get("kind", "bilinear"), _INTEGRATOR_FORMS["bilinear"]))
    if integrator.get("alg"):
        lines[-1] += rf", \text{{alg: {_fmt(integrator['alg'])}}}"
    lines.append(r"& \widetilde{U}_1 = I" + (rf",\; N = {problem['N']}" if "N" in problem else ""))
    bounds = _bound_terms(problem)
    if bounds:
        lines.append(r"& " + r",\quad ".join(bounds))
    if problem.get("free_phase"):
        lines.append(r"& \text{free per-component virtual-Z phases (objective-only)}")
    if problem.get("free_dt"):
        lines.append(r"& \Delta t_k \text{ free}")
    if "final_fidelity" in problem:
        lines.append(r"& \mathcal{F}(U_N) \ge " + str(problem["final_fidelity"]))
    lines.append(r"\end{split}")

    meta: list[str] = []
    meta.append(f"trajectory: {_fmt(traj)}")
    if integrator.get("kind"):
        meta.append(f"integrator: {_fmt(integrator['kind'])}" + (f" ({_fmt(integrator['alg'])})" if integrator.get("alg") else ""))
    if system.get("template"):
        meta.append(f"system: {_fmt(system['template'])}")
    elif system.get("kind") == "raw":
        meta.append(f"system: raw ({_cap_matrix(system.get('H_drift', '?'))})")
    if goal.get("kind"):
        g = f"goal: {_fmt(goal['kind'])}"
        if goal.get("gate"):
            g += f" {_fmt(goal['gate'])}"
        meta.append(g)
    if wrappers:
        meta.append(f"wrappers: {_fmt(wrappers)}")
    if solver:
        meta.append("solver: " + _fmt(", ".join(f"{k}={v}" for k, v in solver.items())))
    lines.append("")
    lines.append(r"{\footnotesize\color{gray}" + "; ".join(meta) + "}")

    stamp = "retained ProblemSpec (extract_spec, verified upstream)" if canonical else "best-effort extraction (upstream `_best_effort_spec`)"
    lines.append(r"{\footnotesize\color{gray}record: " + stamp + "}")
    return "\n".join(lines)


def stated_components(record: dict) -> list[str]:
    """The component names a report's prose may reference — the gate checks
    prose mentions against exactly this set."""
    comps = set()
    integrator = record.get("integrator", {})
    if integrator.get("kind"):
        comps.add(integrator["kind"])
    if integrator.get("alg"):
        comps.add(integrator["alg"])
    comps.update(k for k in ("Q", "R", "R_u", "R_du", "R_ddu", "du_bound", "ddu_bound", "free_phase", "free_dt", "final_fidelity") if k in record.get("problem", {}))
    if record.get("trajectory", {}).get("kind"):
        comps.add(record["trajectory"]["kind"])
    for w in record.get("wrappers", []) or []:
        comps.add(str(w))
    return sorted(comps)


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv[1:]
    if len(args) != 1:
        print("usage: render_formulation.py <formulation.toml>", file=sys.stderr)
        return 2
    record = tomllib.loads(Path(args[0]).read_text(encoding="utf-8"))
    print(render_block(record))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())