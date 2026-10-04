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
    "bilinear": r"U_{k+1} = A(\mathbf{a}_k)\,U_k \text{ (piecewise-constant, first-order)}",
    "hermitian_exponential": r"U_{k+1} = e^{-iH(\mathbf{a}_k)\Delta t}\,U_k \text{ (Pad\'e-13 internal step evaluation)}",
    "nonhermitian_exponential": r"\rho_{k+1} = e^{\mathcal{L}(\mathbf{a}_k)\Delta t}\rho_k,\; \mathcal{L}(\cdot) = -i[H,\cdot] + \text{diss.} \text{ (Daleckii--Krein derivative)}",
    "spline": r"\text{spline-faithful: the constraint integrates the exact spline waveform reconstructed from knot values}",
}


def _fmt(x: object) -> str:
    return str(x).replace("_", r"\_")


def _weight_terms(problem: dict) -> list[str]:
    """Regularizer/objective weights actually present — never invented."""
    terms = []
    for key, label in (
        ("Q", r"Q\,\ell(\widetilde{U}_N)"),
        ("R", r"R\,\lVert\mathbf{a}\rVert^2"),
        ("R_u", r"R_u\,\lVert u\rVert^2"),
        ("R_du", r"R_{du}\,\lVert \mathrm{d}u\rVert^2"),
        ("R_ddu", r"R_{ddu}\,\lVert \mathrm{d}^2u\rVert^2"),
    ):
        if key in problem:
            terms.append(f"{label} \\text{{ with }} {key} = {problem[key]}")
    if "objectives" in problem:
        terms.append(_fmt(str(problem["objectives"])))
    return terms


def _bound_terms(problem: dict) -> list[str]:
    bounds = []
    if "du_bound" in problem:
        bounds.append(r"\lVert\mathrm{d}u\rVert \le " + str(problem["du_bound"]))
    if "ddu_bound" in problem:
        bounds.append(r"\lVert\mathrm{d}^2u\rVert \le " + str(problem["ddu_bound"]))
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
    """The classic-form statement, in the papers' register: one clean
    display equation, then a 'Here, ...' prose paragraph carrying every
    detail from the record — numbers, integrator, alg, weights, bounds,
    solver. Nothing but symbols inside the math; no identifiers crammed
    into equations."""
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
    traj = record.get("trajectory", {}).get("kind", "unitary")

    state_sym = r"\widetilde{U}" if traj != "ket" else r"\widetilde{\psi}"

    # ── the equation: symbols only ──
    obj_terms = []
    if "Q" in problem:
        obj_terms.append(rf"Q\,\ell({state_sym}_N)")
    for key, term in (
        ("R", r"R\,\lVert\mathbf{a}\rVert^2"),
        ("R_u", r"R_u\,\lVert u\rVert^2"),
        ("R_du", r"R_{du}\,\lVert \mathrm{d}u\rVert^2"),
        ("R_ddu", r"R_{ddu}\,\lVert \mathrm{d}^2u\rVert^2"),
    ):
        if key in problem:
            obj_terms.append(term)
    if "objectives" in problem:
        obj_terms.append(r"\text{(recorded terms)}")
    objective = r" + ".join(obj_terms) if obj_terms else rf"\ell({state_sym}_N)"

    rows = [rf"\underset{{z_{{1:N}}}}{{\text{{minimize}}}}\quad & {objective}"]
    rows.append(rf"\text{{subject to}}\quad & {state_sym}_{{k+1}} = F({state_sym}_k, \mathbf{{a}}_k, \Delta t_k)")
    rows.append(rf"& {state_sym}_1 = I" + (rf",\; N = {problem['N']}" if "N" in problem else ""))
    bounds_rows = []
    if "du_bound" in problem:
        bounds_rows.append(r"\lVert\mathrm{d}u\rVert \le d_u")
    if "ddu_bound" in problem:
        bounds_rows.append(r"\lVert\mathrm{d}^2u\rVert \le d_{du}")
    if "global_bounds" in problem:
        bounds_rows.append(r"\text{(recorded global bounds)}")
    if bounds_rows:
        rows.append("& " + r",\quad ".join(bounds_rows))
    if "final_fidelity" in problem:
        rows.append(r"& \mathcal{F}(" + state_sym + r"_N) \ge \bar{\mathcal{F}}")

    eq_lines = [r"\[\begin{split}"]
    for i, row in enumerate(rows):
        eq_lines.append(row + (r" \\" if i < len(rows) - 1 else ""))
    eq_lines.append(r"\end{split}\]")

    # ── the 'Here, ...' prose: every detail from the record ──
    prose: list[str] = []
    weight_details = ", ".join(f"{k} = {problem[k]}" for k in ("Q", "R", "R_u", "R_du", "R_ddu") if k in problem)
    if weight_details:
        prose.append(f"Here, ${weight_details}$;")

    integrator_kind = integrator.get("kind")
    integrator_alg = integrator.get("alg") or solver.get("integrator_alg")
    integrator_phrase = {
        "bilinear": "piecewise-constant (bilinear, first-order)",
        "hermitian_exponential": r"the exact exponential step $U_{k+1} = e^{-iH(\mathbf{a}_k)\Delta t}U_k$",
        "nonhermitian_exponential": r"the exact exponential of the Liouvillian, $\rho_{k+1} = e^{\mathcal{L}(\mathbf{a}_k)\Delta t}\rho_k$",
        "spline": "spline-faithful --- the constraint integrates the exact spline waveform reconstructed from the knot values",
    }.get(integrator_kind or "spline" if integrator_kind is None and integrator_alg else integrator_kind or "bilinear",
          "piecewise-constant (bilinear, first-order)")
    if integrator_kind is None and integrator_alg:
        alg_note = f" ({_fmt(integrator_alg)}, from the call-site actuals)"
    else:
        alg_note = f" ({_fmt(integrator_alg)})" if integrator_alg else ""
    prose.append(f"the dynamics $F$ are {integrator_phrase}{alg_note};")

    details: list[str] = []
    if "N" in problem:
        details.append(f"$N = {problem['N']}$ knots")
    if problem.get("free_phase"):
        details.append("per-component virtual-Z phases free (objective-only)")
    if problem.get("free_dt"):
        details.append(r"$\Delta t_k$ free")
    if "final_fidelity" in problem:
        details.append(rf"final-fidelity floor $\mathcal{{F}} \ge {problem['final_fidelity']}$")
    if "du_bound" in problem:
        details.append(f"$d_u = {problem['du_bound']}$")
    if "ddu_bound" in problem:
        details.append(f"$d_{{du}} = {problem['ddu_bound']}$")
    if wrappers:
        details.append(f"wrappers: {_fmt(wrappers)}")
    if details:
        prose.append("; ".join(details) + ".")

    goal_bits = []
    if goal.get("kind"):
        base = f"a {goal['kind']} target"
    else:
        base = "the target"
    if goal.get("gate"):
        base = f"the {_fmt(goal['gate'])} {goal.get('kind', '')} target"
    if goal.get("subsystem_levels"):
        base += f" on the {_fmt(goal['subsystem_levels'])} computational subspace"
    if goal.get("matrix") is not None:
        base += " (inline goal matrix)"
    goal_bits.append(base)
    sys_bits = []
    if system.get("template"):
        sys_bits.append(f"the {_fmt(system['template'])} system template")
    elif system.get("kind") == "raw":
        sys_bits.append(f"a raw system (Hamiltonian inline, {_cap_matrix(system.get('H_drift', '?'))})")
    sentences = []
    if goal_bits:
        sentences.append("The target is " + ", ".join(goal_bits))
    if sys_bits:
        sentences.append("the system is " + ", ".join(sys_bits))
    if sentences:
        prose.append("; ".join(sentences) + ".")

    if solver:
        named = []
        backend = solver.get("backend", "ipopt")
        iters = solver.get("max_iter", solver.get("max_iter_phase1"))
        named.append(f"{backend}")
        if iters:
            named.append(f"max\_iter {iters}")
        if solver.get("max_cpu_time_s") or solver.get("max_cpu_time"):
            named.append(f"max\_cpu\_time {solver.get('max_cpu_time_s', solver.get('max_cpu_time'))} s")
        if solver.get("tol"):
            named.append(f"tol {solver['tol']}")
        hess = [(k.replace("eval_hessian_", ""), v) for k, v in solver.items() if k.startswith("eval_hessian_")]
        if hess:
            named.append("eval\_hessian " + ", ".join(f"{str(v).lower()} ({k})" for k, v in hess))
        rest = [f"{k}={v}" for k, v in solver.items() if k not in ("backend", "max_iter", "max_iter_phase1", "max_cpu_time_s", "max_cpu_time", "tol", "integrator_alg", "integrator_tol") and not k.startswith("eval_hessian_")]
        prose.append("Solved with " + ", ".join(named) + ("; " + _fmt(", ".join(rest)) if rest else "") + ".")

    stamp = (
        r"retained ProblemSpec (extract\_spec, verified upstream)"
        if canonical
        else r"best-effort extraction (upstream \texttt{\_best\_effort\_spec}); call-site solver actuals"
    )

    out = eq_lines + [""] + prose
    if not canonical:
        out.append(r"{\footnotesize\color{gray}\emph{Non-canonical record} (hand-built problem; system and goal are raw inlines; the solver block is call-site actuals, not a verified round-trip).}")
    out.append(r"{\footnotesize\color{gray}record: " + stamp + "}")
    return "\n".join(out)


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