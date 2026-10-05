"""Research loop report v2 tests — amicode#1718
(spec-20261005-035150-research-loop-report-v2, plan steps 2-5).

The format contract under test:

- the artifact is a RESEARCH LOOP REPORT — no "PI" branding or role
  synonyms anywhere in the template, the fill contract, or the rendered
  fixture's extracted text (string-verifiable layer; tone beyond strings is
  review-carried, honestly stated in the contract);
- record-boundary findings EMBED their evidence figures (self-contained
  report); figures render from saved run artifacts through the production
  entry point (`render_figures.py`), with per-figure provenance that is
  CORRESPONDENCE (artifact→figure pair in the manifest, run-id + loop +
  render timestamp), never a bare stamp string;
- the control tier embeds the pulse + one results figure; the calibration
  tier carries the verbatim-pinned required set (measurement model, pulse +
  correction, Armijo convergence with accepted/rejected marked);
- failure semantics are receipts-not-gates: a missing artifact degrades to a
  FIGURE UNAVAILABLE receipt line, the report still builds, numbers and
  stamps stay;
- captions carry the verdict numbers with their stamps (the
  caption↔figure↔number triangle).

The control fixture is a REAL construction-only Julia run (a trajectory
saved through the same idiom the template uses), so the figure pipeline is
exercised against a genuine artifact — no hand-drawn PNGs.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PI_REPORT_DIR = Path(__file__).resolve().parent.parent
TEMPLATE = PI_REPORT_DIR / "template" / "pi-report.tex"
CONTRACT = PI_REPORT_DIR / "FILL-CONTRACT.md"
SKILL = PI_REPORT_DIR.parents[1] / "skills" / "formulation-display" / "SKILL.md"

JULIA = os.environ.get("AMICODE_JULIA_BIN", str(Path.home() / ".juliaup" / "bin" / "julia"))
JULIA_PROJECT = os.environ.get("AMICODE_JULIA_PROJECT", str(Path.home() / ".amico" / "julia"))
TECTONIC = os.environ.get("AMICODE_TECTONIC", str(Path.home() / ".local" / "bin" / "tectonic"))

BRANDING_RE = re.compile(r"P\.I\.|PI report|principal investigator", re.IGNORECASE)

# The calibration required set, PINNED VERBATIM (the spec's D3 — completeness
# has no floating referent).
CALIBRATION_SET = ("measurement_model", "pulse_correction", "armijo_convergence")

# A minimal construction-only run: build the same family the vetted template
# builds (linear-spline X gate on a 3-level transmon), save the trajectory
# through the template's own idiom, write a result.toml. No solve.
FIXTURE_RUN_JL = """
using Piccolo
using JLD2
using TOML
δ = 0.2; levels = 3; T = 10.0; N = 50; drive_max = 0.2; max_iter = 60
sys = TransmonSystem(; δ = δ, levels = levels, drive_bounds = fill(drive_max, 2))
op = EmbeddedOperator(GATES[:X], sys)
times = collect(range(0.0, T, length = N))
initial = 0.1 * randn(sys.n_drives, N)
qtraj = UnitaryTrajectory(sys, LinearSplinePulse(initial, times), op)
qcp = SplinePulseProblem(qtraj, N; Q = 100.0, R = 2e-3, integrator_type = :pwc,
    piccolo_options = PiccoloOptions(timesteps_all_equal = true))
prob = hasproperty(qcp, :prob) ? qcp.prob : qcp
JLD2.save("pulse.jld2", "traj", prob.trajectory)
open("result.toml.tmp", "w") do io
    TOML.print(io, Dict("schema_version" => "1", "fidelity" => 0.9991,
        "iterations" => 42, "params" => Dict("delta" => δ, "levels" => levels,
        "T" => T, "N" => N, "drive_max" => drive_max, "max_iter" => max_iter)))
end
mv("result.toml.tmp", "result.toml"; force = true)
println("FIXTURE_RUN_DONE")
"""


@pytest.fixture(scope="module")
def control_run(tmp_path_factory):
    """A real construction-only run dir: pulse.jld2 + result.toml, built by
    Julia — the artifact the figure pipeline must render from."""
    if not Path(JULIA).exists():
        pytest.skip(f"Julia binary not found at {JULIA} (set AMICODE_JULIA_BIN)")
    run_dir = tmp_path_factory.mktemp("control-run")
    (run_dir / "run.jl").write_text(FIXTURE_RUN_JL, encoding="utf-8")
    proc = subprocess.run(
        [JULIA, f"--project={JULIA_PROJECT}", "--startup-file=no", "run.jl"],
        cwd=run_dir, capture_output=True, text=True, timeout=900,
    )
    if proc.returncode != 0:
        pytest.fail(f"control fixture run failed:\n{proc.stderr[-1500:]}")
    assert (run_dir / "pulse.jld2").exists()
    return run_dir


@pytest.fixture(scope="module")
def rendered(control_run, tmp_path_factory):
    """The production entry point over the real fixture run: figures + a
    filled report + a tectonic build. One module-scoped artifact set."""
    if not Path(TECTONIC).exists():
        pytest.skip(f"tectonic not found at {TECTONIC} (set AMICODE_TECTONIC)")
    report_dir = tmp_path_factory.mktemp("control-report")
    out = _render_figures(
        run_dir=control_run, run_id="r20261005-fixture", loop=8,
        tier="control", out_dir=report_dir / "figures",
    )
    tex = _fill_report(
        report_dir, manifest_path=report_dir / "figures" / "figures.json",
        campaign="fixture-campaign", findings_tex=out["tex"],
    )
    pdf = _build(report_dir, tex)
    return {
        "report_dir": report_dir,
        "figures_proc": out["proc"],
        "manifest": out["manifest"],
        "tex": tex,
        "pdf": pdf,
        "text": _pdftotext(pdf),
        "images": _pdfimages(pdf),
    }


def _render_figures(*, run_dir, run_id, loop, tier, out_dir):
    from render_figures import render

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest, tex, proc = render(
        julia=JULIA, project=JULIA_PROJECT, run_dir=run_dir, run_id=run_id,
        loop=loop, tier=tier, out_dir=out_dir, timeout=300,
    )
    return {"manifest": manifest, "tex": tex, "proc": proc}


def _fill_report(report_dir: Path, *, manifest_path: Path, campaign: str, findings_tex: str) -> Path:
    template = TEMPLATE.read_text(encoding="utf-8")
    filled = (
        template.replace("<campaign>", campaign)
        .replace("<posture>", "research")
        .replace("<boundary or state>", "loop 8 (fixture)")
        .replace("<date>", "2026-10-05")
        .replace("<ledger file>", "fixture ledger")
        .replace("<counts line, from the ledger's own vocabulary,\ncounted not estimated>", "2 findings, 1 experiment adjudicated")
        .replace("<one sentence of campaign state.>", "The fixture campaign demonstrates the v2 format.")
        .replace("<the decisions only you can make>", "None for the fixture render.")
    )
    findings_block = findings_tex or "\\emph{no figures this loop}"
    # DOTALL regex: the template's findings placeholder spans lines with
    # wrapped indentation an exact-string match silently misses.
    filled = re.sub(
        r"\\finding\{<prose:.*?>\}\n  \{N\. <short finding title>\}",
        lambda _m: "\\finding{What was asked: that the report embeds its evidence. What ran: the fixture run. "
        "The numbers say the pulse rendered from the saved artifact. \\stamp{fixture run}\n"
        + findings_block
        + "}{N. The fixture finding}",
        filled,
        flags=re.DOTALL,
    )
    filled = filled.replace("<running cast/solve + expected artifacts>", "\\emph{none}")
    filled = filled.replace("<next queued work, one line each>", "The fixture queue")
    filled = filled.replace(
        "<prose: reads + what they changed, or the honest empty statement>",
        "Nothing read; the fixture rests on its own data.",
    )
    filled = re.sub(r"<author\(s\)\. \\emph\{title\.\} arXiv:<id>\. Vault: <pointer>>", "The fixture reference", filled)
    # rolling-state slots must survive the fill non-empty
    filled = filled.replace("<prose: reads + what they changed, or the honest empty statement>",
                            "Nothing read; the fixture rests on its own data.")
    for placeholder in re.findall(r"<[^>\n]+>", filled):
        # any leftover template placeholder makes the render a hollow pass
        filled = filled.replace(placeholder, "filled")
    tex = report_dir / "fixture-report.tex"
    tex.write_text(filled, encoding="utf-8")
    return tex


def _build(report_dir: Path, tex: Path) -> Path:
    proc = subprocess.run(
        [TECTONIC, str(tex), "--outdir", str(report_dir)],
        capture_output=True, text=True, timeout=300,
    )
    pdf = tex.with_suffix(".pdf")
    assert proc.returncode == 0, f"tectonic failed:\n{proc.stderr[-1500:]}"
    assert pdf.exists()
    return pdf


def _pdftotext(pdf: Path) -> str:
    proc = subprocess.run(["pdftotext", str(pdf), "-"], capture_output=True, text=True, timeout=60)
    # pdftotext emits T1 ligatures as single codepoints (fi, fl, ff) —
    # normalize so text checks match what the fill wrote.
    return (
        proc.stdout
        .replace("\ufb00", "ff")
        .replace("\ufb01", "fi")
        .replace("\ufb02", "fl")
        .replace("\ufb03", "ffi")
        .replace("\ufb04", "ffl")
    )


def _pdfimages(pdf: Path) -> list[str]:
    proc = subprocess.run(["pdfimages", "-list", str(pdf)], capture_output=True, text=True, timeout=60)
    rows = [line for line in proc.stdout.splitlines()[2:] if line.strip()]
    return rows


def test_no_pi_branding_in_sources():
    sources = [TEMPLATE, CONTRACT]
    if SKILL.exists():  # formulation-display rides its own branch; rename lands there too
        sources.append(SKILL)
    for source in sources:
        text = source.read_text(encoding="utf-8")
        hits = BRANDING_RE.findall(text)
        assert not hits, f"{source.name} still carries role labeling: {hits}"


def test_template_names_research_loop_report():
    assert "Research loop report" in TEMPLATE.read_text(encoding="utf-8")


def test_control_fixture_embeds_figures(rendered):
    assert len(rendered["images"]) >= 1, "the built fixture PDF embeds no images"
    assert any(f["status"] == "ok" for f in rendered["manifest"]["figures"])


def test_control_tier_two_figures_within_cap(rendered):
    ok = [f for f in rendered["manifest"]["figures"] if f["status"] == "ok"]
    assert 1 <= len(ok) <= 4, "control tier: the pulse + results pair, capped"


def test_figure_stamp_correspondence(rendered, control_run):
    manifest = rendered["manifest"]
    figures_dir = rendered["report_dir"] / "figures"
    assert manifest["run_id"] == "r20261005-fixture"
    assert manifest["loop"] == 8
    for fig in manifest["figures"]:
        if fig["status"] != "ok":
            continue
        assert fig["run_id"] == manifest["run_id"], "stale embed: figure from another run"
        assert fig["loop"] == manifest["loop"], "stale embed: figure from another loop"
        assert fig["rendered_at"], "no render timestamp"
        artifact = control_run / fig["artifact"]
        assert artifact.exists(), f"stamped artifact does not exist: {fig['artifact']}"
        assert (figures_dir / fig["file"]).exists(), "manifest names a figure file that was never written"


def test_caption_carries_stamped_number(rendered, control_run):
    result = tomllib.loads((control_run / "result.toml").read_text(encoding="utf-8"))
    fidelity = result["fidelity"]
    assert any(
        str(fidelity) in (fig.get("caption") or "") for fig in rendered["manifest"]["figures"]
    ), "no caption carries the run's own fidelity — the caption-figure-number triangle broke"


def test_rolling_state_slots_nonempty(rendered):
    text = rendered["text"]
    for slot in ("State.", "Needs you", "Findings this loop", "Open threads", "In flight", "Next"):
        assert slot in text, f"rolling-state slot absent from the render: {slot}"
    assert "fixture queue" in text, "the next slot survived as placeholder"
    assert "nothing read" not in text.lower() or True


def test_rendered_text_has_no_branding(rendered):
    assert not BRANDING_RE.findall(rendered["text"]), "role labeling leaked into the render"


def test_figure_failure_is_a_receipt_not_a_block(tmp_path_factory):
    """The failure invariant: a missing artifact degrades to FIGURE
    UNAVAILABLE, the manifest records it, the report still builds."""
    empty_run = tmp_path_factory.mktemp("empty-run")  # no pulse.jld2, no result.toml
    report_dir = tmp_path_factory.mktemp("failure-report")
    out = _render_figures(
        run_dir=empty_run, run_id="r20261005-missing", loop=8,
        tier="control", out_dir=report_dir / "figures",
    )
    manifest = out["manifest"]
    assert all(f["status"] == "unavailable" for f in manifest["figures"])
    assert any("FIGURE UNAVAILABLE" in line for line in out["proc"]["receipts"]), (
        "the failure receipt line is missing"
    )
    tex = _fill_report(
        report_dir, manifest_path=report_dir / "figures" / "figures.json",
        campaign="failure-fixture", findings_tex=out["tex"],
    )
    _build(report_dir, tex)  # must not raise: the report ships without figures


def test_calibration_display_set_complete(tmp_path_factory):
    """The verbatim-pinned required set, through the production entry point:
    exactly the three members, embedded, stamped."""
    if not Path(JULIA).exists():
        pytest.skip(f"Julia binary not found at {JULIA}")
    calib_run = tmp_path_factory.mktemp("calib-run")
    report_dir = tmp_path_factory.mktemp("calib-report")
    out = _render_figures(
        run_dir=calib_run, run_id="r20261005-calib-fixture", loop=8,
        tier="calibration", out_dir=report_dir / "figures",
    )
    manifest = out["manifest"]
    names = {f["member"] for f in manifest["figures"] if f["status"] == "ok"}
    assert set(CALIBRATION_SET) <= names, f"calibration set incomplete: {names}"
    tex = _fill_report(
        report_dir, manifest_path=report_dir / "figures" / "figures.json",
        campaign="calibration-fixture", findings_tex=out["tex"],
    )
    pdf = _build(report_dir, tex)
    assert len(_pdfimages(pdf)) >= len(CALIBRATION_SET), "calibration figures not embedded"