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

def test_template_actuals_integrator_beats_inference():
    """The #540 honesty case: a SplinePulseProblem whose dynamics are PWC
    collocation (integrator_type = pwc in template_actuals) must NEVER render
    as spline-faithful — call-site actuals beat template-name inference."""
    record = tomllib.loads(
        (FIXTURES / "hand-built.toml").read_text(encoding="utf-8")
    )
    record.pop("integrator", None)
    record["problem"] = {"template": "SplinePulseProblem", "N": 50, "Q": 100.0}
    record["template_actuals"] = {
        "integrator_type": "pwc",
        "R_rule": "R = 1e-2 * dt computed from the grid",
    }
    out = render_block(record)
    assert "piecewise-constant" in out
    assert "spline-faithful" not in out
    assert "template actuals" in out


def test_partial_record_alarm():
    """A record missing inventory rows renders with a visible PARTIAL-RECORD
    flag naming the missing rows — the standing alarm, not a one-time probe."""
    record = {
        "kind": "control",
        "system": {"kind": "raw", "H_drift": "[[0,0],[0,4]]"},
        "trajectory": {"kind": "unitary"},
        "problem": {"template": "SplinePulseProblem", "N": 50},
    }
    out = render_block(record)
    assert "PARTIAL-RECORD" in out
    assert r"schema\_version" in out  # row names ride LaTeX-escaped
    assert "goal" in out
    assert "objective weights" in out
    assert "solver actuals" in out


def test_complete_record_has_no_partial_alarm():
    record = tomllib.loads((FIXTURES / "hand-built.toml").read_text(encoding="utf-8"))
    record["schema_version"] = 1
    out = render_block(record)
    assert "PARTIAL-RECORD" not in out


def test_unknown_block_tolerated():
    """D5: a record carrying a block this renderer does not map renders fine,
    never fails, and the unmapped block is named in the output (preserved,
    not silently dropped)."""
    record = tomllib.loads((FIXTURES / "spec-built.toml").read_text(encoding="utf-8"))
    record["experiment"] = {"shots": 1024, "readout": "default"}
    out = render_block(record)  # must not raise
    assert "The target is" in out
    assert "experiment" in out


def test_emission_capped_matrix_passthrough():
    """A record capped AT EMISSION carries the capped marker as the matrix
    value; the render passes it through as-is instead of re-digesting the
    marker string into a phantom 'inline' matrix."""
    record = load("hand-built.toml")
    capped = "<capped matrix: 3x3, fnv64:d3adbeefcafe1234>"
    record["system"]["H_drift"] = capped
    out = render_block(record)
    assert capped in out
    assert "inline matrix" not in out


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
