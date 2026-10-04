"""Emission tests — amicode#1710 (disclosure-system spec, plan step 2).

The formulation.toml emission idiom in the vetted template and the free-tier
skeleton. The contract under test (the spec's frozen doctrine):

- fire-and-forget — a failed emission is one receipt line, the solve always
  proceeds (tested with a poisoned write path);
- atomic write (tmp + mv, the result.toml pattern);
- ``canonical`` is DERIVED from ``retained_spec`` (never asserted): the
  template's kwargs-built problem is hand-built upstream → best-effort,
  ``canonical = false``; a materialized problem is canonical;
- raw matrices capped to digest + dims AT EMISSION (run dirs sync across
  machines);
- call-site ``template_actuals``/``solver_actuals`` blocks, honestly labeled.

The fixtures are SLICED FROM THE ACTUAL TEMPLATE/SKELETON SOURCE — zero fixture
drift: the template's prefix (construction + emission, no solve) runs
construction-only and proves the template's real path; a problem materialized
from a spec runs through the SAME sliced emission block and proves the
canonical branch; the skeleton's CONTRACT blocks run with the skeleton's own
documented AUTHOR example filled in.
"""

from __future__ import annotations

import os
import subprocess
import tomllib
from pathlib import Path

import pytest

PI_REPORT_DIR = Path(__file__).resolve().parent.parent
EXTENSION_DIR = PI_REPORT_DIR.parents[1]
TEMPLATE = EXTENSION_DIR / "scores" / "pulse-designer" / "templates" / "solve.jl"
SKELETON = EXTENSION_DIR / "templates" / "skeleton_free.jl"

JULIA = os.environ.get("AMICODE_JULIA_BIN", str(Path.home() / ".juliaup" / "bin" / "julia"))
JULIA_PROJECT = os.environ.get("AMICODE_JULIA_PROJECT", str(Path.home() / ".amico" / "julia"))

EMISSION_BEGIN = "# ── CONTRACT: formulation record (#1710)"
EMISSION_END = "# ── end formulation record"
SKELETON_EMISSION_BEGIN = "# ── CONTRACT: formulation record (DO NOT EDIT)"
SKELETON_TELEMETRY_BEGIN = "# ── CONTRACT: telemetry + solve + artifacts"
SKELETON_VERIFY_BEGIN = "# ── CONTRACT: verification snapshot"
AUTHOR_BEGIN = "# ── AUTHOR"

# The skeleton's own documented AUTHOR example (skeleton_free.jl lines 24-27
# and 33-38) — an author following the skeleton produces exactly this.
SKELETON_AUTHOR_SYSTEM_GOAL = """
δ = 0.2; levels = 3; T = 10.0; N = 50; drive_max = 0.2; max_iter = 60
sys = TransmonSystem(; δ = δ, levels = levels, drive_bounds = fill(drive_max, 2))
op  = EmbeddedOperator(GATES[:X], sys)
"""
SKELETON_AUTHOR_TRAJECTORY = """
times   = collect(range(0.0, T, length = N))
initial = 0.1 * randn(sys.n_drives, N)
qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(initial, times), op)
qcp = SmoothPulseProblem(qtraj, N; piccolo_options = PiccoloOptions(timesteps_all_equal = true), Q = 100.0, R = 1e-2)
prob = hasproperty(qcp, :prob) ? qcp.prob : qcp
"""

# A problem MATERIALIZED from this spec is the canonical path (the spec is
# retained upstream and extract_spec verifies it against the object).
SPEC_TOML = """
schema_version = 1
kind = "control"
[system]
kind = "template"
template = "TransmonSystem"
params = { levels = 3, drive_bounds = [0.02, 0.02] }
[goal]
kind = "unitary"
gate = "X"
[pulse]
kind = "cubic_spline"
T = 10.0
[problem]
template = "SplinePulseProblem"
N = 11
Q = 250.0
"""

CANONICAL_HARNESS = """
module CanonicalFixture
using Piccolo
using TOML
emit(s) = (println(s); flush(stdout))
SOLVER = :ipopt
max_iter = 60
TEMPLATE_ACTUALS = Dict{String,Any}()   # spec-built: the retained spec carries the params
SOLVER_ACTUALS = Dict{String,Any}("backend" => string(SOLVER), "max_iter" => max_iter)
const SPEC_TOML = \"\"\"{spec_toml}\"\"\"
spec = Piccolo.Specs.parse_spec(SPEC_TOML; format = :toml)
qcp = Piccolo.Specs.materialize(spec)
include("emission_block.jl")
end
println("CANONICAL_DONE")
"""


def _lines(path: Path) -> list[str]:
    return Path(path).read_text(encoding="utf-8").splitlines()


def _slice_block(lines: list[str], begin_prefix: str, end_prefix: str) -> list[str]:
    begin = next(i for i, line in enumerate(lines) if line.startswith(begin_prefix))
    end = next(i for i, line in enumerate(lines) if i > begin and line.startswith(end_prefix))
    return lines[begin : end + 1]


def _require_markers(lines: list[str], source: str, *prefixes: str) -> None:
    """Marker absence is a loud failure, never a silent skip — deleting the
    emission block must fail the suite, not skip it."""
    for prefix in prefixes:
        if not any(line.startswith(prefix) for line in lines):
            pytest.fail(f"{source} lacks the formulation-record emission block (marker {prefix!r} absent)")


def _run_julia(script: Path, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [JULIA, f"--project={JULIA_PROJECT}", "--startup-file=no", str(script)],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=900,
    )


def _read_record(path: Path) -> dict | None:
    if not path.exists():
        return None
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _build_skeleton_fixture_script() -> str:
    """The skeleton with its own documented AUTHOR example filled in, sliced
    through the end of the formulation-record CONTRACT (no solve)."""
    lines = _lines(SKELETON)
    header_end = next(i for i, line in enumerate(lines) if line.startswith(AUTHOR_BEGIN))
    verify_begin = next(i for i, line in enumerate(lines) if line.startswith(SKELETON_VERIFY_BEGIN))
    telemetry_begin = next(i for i, line in enumerate(lines) if line.startswith(SKELETON_TELEMETRY_BEGIN))
    header = "\n".join(lines[:header_end])
    contract_blocks = "\n".join(lines[verify_begin:telemetry_begin])
    return "\n".join([header, SKELETON_AUTHOR_SYSTEM_GOAL, SKELETON_AUTHOR_TRAJECTORY, contract_blocks]) + "\n"


@pytest.fixture(scope="module")
def emitted(tmp_path_factory):
    """Runs the Julia fixtures once (a Piccolo load dominates each spawn;
    four spawns total). Every fixture's failure mode is a loud fail, never a
    skip: a construction crash is surfaced with its stderr tail."""
    if not Path(JULIA).exists():
        pytest.skip(f"Julia binary not found at {JULIA} (set AMICODE_JULIA_BIN)")

    tlines = _lines(TEMPLATE)
    slines = _lines(SKELETON)
    _require_markers(
        tlines, str(TEMPLATE), EMISSION_BEGIN, EMISSION_END
    )
    _require_markers(
        slines, str(SKELETON), SKELETON_EMISSION_BEGIN, SKELETON_TELEMETRY_BEGIN
    )

    base = tmp_path_factory.mktemp("emission")
    out: dict[str, dict] = {}

    def run(name: str, script_text: str, poison: bool = False) -> None:
        run_dir = base / name
        run_dir.mkdir()
        (run_dir / "run.jl").write_text(script_text, encoding="utf-8")
        if poison:
            # A directory where the script expects to open() its tmp file:
            # the write path fails, the receipt line fires, the run must exit 0.
            (run_dir / "formulation.toml.tmp").mkdir()
        proc = _run_julia(run_dir / "run.jl", run_dir)
        out[name] = {
            "proc": proc,
            "record": _read_record(run_dir / "formulation.toml"),
            "record_path": run_dir / "formulation.toml",
        }
        if proc.returncode != 0:
            pytest.fail(
                f"{name}: construction-only Julia run failed (exit {proc.returncode}). "
                f"stderr tail:\n{proc.stderr[-2000:]}"
            )

    # A — the template's REAL path: construction + emission, sliced verbatim.
    emission_end_idx = next(i for i, line in enumerate(tlines) if line.startswith(EMISSION_END))
    run("template", "\n".join(tlines[: emission_end_idx + 1]) + "\n")

    # B — the canonical branch: a materialized problem through the SAME
    #     emission block (sliced from the template, zero drift).
    block = "\n".join(_slice_block(tlines, EMISSION_BEGIN, EMISSION_END)) + "\n"
    dir_b = base / "materialize"
    dir_b.mkdir()
    (dir_b / "emission_block.jl").write_text(block, encoding="utf-8")
    (dir_b / "run.jl").write_text(
        CANONICAL_HARNESS.replace("{spec_toml}", SPEC_TOML.strip()), encoding="utf-8"
    )
    proc_b = _run_julia(dir_b / "run.jl", dir_b)
    out["materialize"] = {
        "proc": proc_b,
        "record": _read_record(dir_b / "formulation.toml"),
        "record_path": dir_b / "formulation.toml",
    }
    if proc_b.returncode != 0:
        pytest.fail(
            f"materialize: canonical-branch fixture failed (exit {proc_b.returncode}). "
            f"stderr tail:\n{proc_b.stderr[-2000:]}"
        )

    # C — poisoned write path: emission fails, the run proceeds (exit 0).
    run("poison", "\n".join(tlines[: emission_end_idx + 1]) + "\n", poison=True)

    # D — the skeleton, authored per its own example, through its CONTRACT.
    run("skeleton", _build_skeleton_fixture_script())

    # E — the BARE extraction of the same template construction (no overlay):
    #     the probe-script path. The identity test proves the idiom's overlay
    #     (canonical flag, actuals blocks, matrix capping) is additive-only —
    #     the spec content itself is untouched.
    dir_e = base / "bare"
    dir_e.mkdir()
    construction_idx = next(
        i for i, line in enumerate(tlines) if line.startswith("prob = hasproperty")
    )
    bare_script = (
        "\n".join(tlines[: construction_idx + 1])
        + '\nbare = full_dict(extract_spec(qcp))\n'
        + 'open("bare.toml", "w") do io; TOML.print(io, bare); end\n'
        + 'println("BARE_DONE")\n'
    )
    (dir_e / "run.jl").write_text(bare_script, encoding="utf-8")
    proc_e = _run_julia(dir_e / "run.jl", dir_e)
    out["bare"] = {
        "proc": proc_e,
        "record": _read_record(dir_e / "bare.toml"),
    }
    if proc_e.returncode != 0:
        pytest.fail(
            f"bare: probe-path extraction failed (exit {proc_e.returncode}). "
            f"stderr tail:\n{proc_e.stderr[-2000:]}"
        )

    return out


def test_record_structure_identity(emitted):
    """The overlay is additive-only: the emitted record's SPEC CONTENT is
    structure-identical to a bare extraction of the same construction (the
    probe-script path), modulo the declared overlay keys and the capped
    matrices. Parsed-structure equality, never byte equality (Julia float
    formatting differs from nothing here — both sides come from the same
    TOML writer — but the comparison is on parsed structures by contract)."""
    emitted_record = emitted["template"]["record"]
    bare_record = emitted["bare"]["record"]
    assert emitted_record is not None and bare_record is not None

    overlay_keys = {"canonical", "template_actuals", "solver_actuals"}
    matrix_paths = (("system", "H_drift"), ("system", "H_drives"), ("goal", "matrix"))

    def normalize(record: dict) -> dict:
        out = {k: v for k, v in record.items() if k not in overlay_keys}
        system = dict(out.get("system", {}))
        for key in ("H_drift", "H_drives"):
            if key in system:
                system[key] = "MATRIX"
        out["system"] = system
        goal = dict(out.get("goal", {}))
        if "matrix" in goal:
            goal["matrix"] = "MATRIX"
        out["goal"] = goal
        return out

    assert normalize(emitted_record) == normalize(bare_record), (
        "the emission overlay must not touch the spec content beyond the "
        "declared keys (canonical, template_actuals, solver_actuals) and "
        "the matrix caps"
    )
    # the overlay is exactly where it claims to be
    assert overlay_keys <= set(emitted_record)
    assert not overlay_keys & set(bare_record)


def test_template_emits_best_effort_record(emitted):
    """The template's production path: kwargs-built problem → best-effort,
    canonical = false, with call-site actuals carrying what the retained
    params drop (integrator_type, the grid-R rule)."""
    record = emitted["template"]["record"]
    assert record is not None, "no formulation.toml emitted by the template prefix"
    assert record["canonical"] is False
    assert record["kind"] == "control"
    assert record["problem"]["template"] == "SplinePulseProblem"
    assert record["problem"]["N"] == 50
    assert record["problem"]["Q"] == 100.0
    problem = record["problem"]
    assert any(
        problem.get(k) == pytest.approx(0.002) for k in ("R_u", "R")
    ), "the grid-computed R (1e-2 * 10/50) must be in the record"
    assert record["system"]["kind"] == "raw"
    assert record["goal"]["kind"] == "unitary"
    assert record["trajectory"]["kind"] == "unitary"
    assert record["pulse"]["kind"] == "linear_spline"
    assert record["template_actuals"]["integrator_type"] == "pwc"
    assert "R_rule" in record["template_actuals"]
    assert record["solver_actuals"]["backend"] == "ipopt"
    assert record["solver_actuals"]["max_iter"] == 60


def test_spec_built_path_emits_canonical_record(emitted):
    """The canonical branch: a problem materialized from a spec, through the
    SAME emission block — canonical derives from retained_spec, not from the
    template's context."""
    record = emitted["materialize"]["record"]
    assert record is not None, "no formulation.toml emitted by the canonical fixture"
    assert record["canonical"] is True
    assert record["system"]["kind"] == "template"
    assert record["system"]["template"] == "TransmonSystem"
    assert record["goal"]["gate"] == "X"
    assert record["problem"]["template"] == "SplinePulseProblem"
    assert record["problem"]["Q"] == 250.0


def test_record_inventory_complete(emitted):
    """The fixed record inventory (the spec's table), each row present with
    its supplying block: schema fields from the upstream spec, integrator
    via template_actuals, solver actuals from the call site."""
    record = emitted["template"]["record"]
    for key in ("schema_version", "kind", "canonical", "system", "goal", "pulse", "trajectory", "problem"):
        assert key in record, f"inventory row missing: {key}"
    # wrappers: present-or-empty (upstream omits empty wrapper lists from the
    # wire form — absence IS the empty list, not a missing row)
    assert isinstance(record.get("wrappers", []), list)
    assert record["schema_version"] is not None
    assert record["problem"]["N"] is not None and record["problem"]["Q"] is not None
    assert record["template_actuals"]["integrator_type"] == "pwc"
    assert record["solver_actuals"]["max_iter"] is not None


def test_record_schema_version_present(emitted):
    """schema_version rides every record from all three emitting surfaces —
    the stale-vs-failed distinguishability contract."""
    for name in ("template", "materialize", "skeleton"):
        record = emitted[name]["record"]
        assert record is not None, f"{name}: no record"
        assert record.get("schema_version") is not None, f"{name}: schema_version absent"
        assert "canonical" in record


def test_record_matrices_capped_at_emission(emitted):
    """Raw matrices never enter a synced run dir: capped to digest + dims at
    emission (the parent spec's trust obligation), in every best-effort
    record from every surface."""
    for name in ("template", "skeleton"):
        record = emitted[name]["record"]
        assert record is not None, f"{name}: no record"
        drift = record["system"]["H_drift"]
        assert isinstance(drift, str) and "capped matrix" in drift, (
            f"{name}: H_drift is not capped (got {type(drift).__name__})"
        )
        assert "fnv64:" in drift
        for drive in record["system"]["H_drives"]:
            assert isinstance(drive, str) and "capped matrix" in drive
        assert isinstance(record["goal"]["matrix"], str) and "capped matrix" in record["goal"]["matrix"]
    # canonical records carry a template system — no raw matrices at all
    assert "H_drift" not in emitted["materialize"]["record"]["system"]


def test_emission_failure_never_blocks_solve(emitted):
    """The frozen invariant, held against emission-code failure: a poisoned
    write path exits 0 with exactly the receipt line, and no record."""
    poison = emitted["poison"]
    assert poison["proc"].returncode == 0, "a failed emission must never block the run"
    assert "AMICODE_RECORD emission failed" in poison["proc"].stdout
    assert not poison["record_path"].exists(), "a failed emission must leave no partial record"
    good = emitted["template"]["proc"].stdout
    assert "AMICODE_RECORD formulation.toml written" in good, "a successful emission prints its receipt line"


def test_template_idiom_is_fire_and_forget():
    """Structural pins on the template's emission block: try/catch wrap,
    atomic tmp+mv write, both receipt lines, the retained_spec discriminator,
    and placement after construction, before the solve."""
    lines = _lines(TEMPLATE)
    _require_markers(lines, str(TEMPLATE), EMISSION_BEGIN, EMISSION_END)
    block = "\n".join(_slice_block(lines, EMISSION_BEGIN, EMISSION_END))
    assert "try" in block and "catch" in block, "the emission must be wrapped fire-and-forget"
    assert 'open("formulation.toml.tmp", "w")' in block
    assert 'mv("formulation.toml.tmp", "formulation.toml"' in block
    assert "AMICODE_RECORD formulation.toml written" in block
    assert "AMICODE_RECORD emission failed" in block
    assert "retained_spec" in block, "canonical must be derived from retained_spec, never asserted"
    begin_idx = next(i for i, line in enumerate(lines) if line.startswith(EMISSION_BEGIN))
    construction_idx = next(i for i, line in enumerate(lines) if line.startswith("prob = hasproperty"))
    solve_idx = next(i for i, line in enumerate(lines) if line.strip().startswith("solve!(qcp"))
    assert construction_idx < begin_idx < solve_idx, "emission sits after construction, before the solve"
    # the per-template actuals live with the surface, above the block
    prelude = "\n".join(lines[:begin_idx])
    assert "TEMPLATE_ACTUALS" in prelude and "SOLVER_ACTUALS" in prelude


def test_skeleton_contract_has_emission_line():
    """The skeleton's frozen CONTRACT carries the emission requirement as its
    own block, between the verification snapshot and the solve telemetry."""
    lines = _lines(SKELETON)
    _require_markers(lines, str(SKELETON), SKELETON_EMISSION_BEGIN, SKELETON_TELEMETRY_BEGIN)
    verify_idx = next(i for i, line in enumerate(lines) if line.startswith(SKELETON_VERIFY_BEGIN))
    emission_idx = next(i for i, line in enumerate(lines) if line.startswith(SKELETON_EMISSION_BEGIN))
    telemetry_idx = next(i for i, line in enumerate(lines) if line.startswith(SKELETON_TELEMETRY_BEGIN))
    assert verify_idx < emission_idx < telemetry_idx, "emission is a CONTRACT block after the verification snapshot"
    block = "\n".join(lines[emission_idx:telemetry_idx])
    assert "try" in block and "catch" in block, "the skeleton emission must be wrapped fire-and-forget"
    assert 'mv("formulation.toml.tmp", "formulation.toml"' in block
    assert "AMICODE_RECORD" in block


def test_skeleton_fixture_emits_valid_record(emitted):
    """A script authored strictly from the skeleton (its own documented
    example filled in) emits a schema-valid record in a construction-only
    run of its CONTRACT blocks."""
    record = emitted["skeleton"]["record"]
    assert record is not None, "the skeleton-authored script emitted no formulation.toml"
    assert record["canonical"] is False
    assert record["schema_version"] is not None
    assert record["problem"]["template"] == "SmoothPulseProblem"
    assert record["problem"]["N"] == 50
    assert record["problem"]["Q"] == 100.0
    assert record["solver_actuals"]["backend"] == "ipopt"
    assert record["solver_actuals"]["max_iter"] == 60
    assert "AMICODE_RECORD formulation.toml written" in emitted["skeleton"]["proc"].stdout