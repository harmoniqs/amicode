"""The formulation-record gates: render-from-record, component matching,
non-canonical labeling, matrix capping. Synthetic fixtures only."""
import sys
import tomllib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from render_formulation import render_block, stated_components  # noqa: E402

FIXTURES = Path(__file__).parent.parent / "fixtures" / "formulation"


def load(name: str) -> dict:
    return tomllib.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_spec_built_renders_components():
    block = render_block(load("spec-built.toml"))
    assert r"spline-faithful" in block
    assert r"magnus\_adapt4" in block
    assert "spline-faithful" in block
    assert "Q = 100.0" in block
    assert "du_bound" not in block or "10.0" in block
    assert "free per-component virtual-Z phases free (objective-only)" in block or "virtual-Z phases free (objective-only)" in block
    assert "Non-canonical record" not in block
    assert "retained ProblemSpec" in block


def test_handbuilt_is_labeled_non_canonical():
    block = render_block(load("hand-built.toml"))
    assert "Non-canonical record" in block
    assert "best-effort extraction" in block
    # solver actuals come from the call site, not the declarative block
    assert r"exact\_hessian=false" in block


def test_raw_matrices_are_capped_to_digest():
    block = render_block(load("hand-built.toml"))
    assert "sha256:" in block
    assert "4.0" not in block.split("sha256:")[1][:80] if "sha256:" in block else True
    # the drift matrix's literal entries never appear anywhere in the render
    assert "8.2" not in block
    assert "sha256:" in block


def test_stated_components_gate_set():
    comps = stated_components(load("spec-built.toml"))
    assert set(["spline", "magnus_adapt4", "unitary", "Q", "R", "du_bound", "free_phase"]) <= set(comps)


def test_missing_record_marks_unbacked():
    """The ops advisory: no record -> every stated formulation is UNBACKED."""
    block = render_block({})
    assert "UNBACKED" in block
    assert "retained ProblemSpec" not in block  # an empty record never claims canonical provenance


def test_renderer_cli(capsys):
    from render_formulation import main
    rc = main([str(FIXTURES / "spec-built.toml")])
    out = capsys.readouterr().out
    assert rc == 0
    assert "spline-faithful" in out

def test_template_implies_spline_integrator():
    """Best-effort record with no integrator block but a Spline template:
    the render states spline-faithful dynamics, honestly sourced."""
    rec = {
        "problem": {"template": "SplinePulseProblem", "N": 11, "Q": 200.0, "free_phase": True},
        "trajectory": {"kind": "unitary"},
        "goal": {"kind": "unitary", "subsystem_levels": [2, 2]},
        "system": {"kind": "raw", "H_drift": [[0.0]]},
        "canonical": False,
        "solver_actuals": {"backend": "ipopt", "max_iter": 500},
        "construction_notes": ["tail knots pinned [0,0] via fixed columns"],
    }
    block = render_block(rec)
    assert "spline-faithful" in block
    assert "bilinear" not in block
    assert "Construction: tail knots pinned" in block
    assert "Non-canonical record" in block
