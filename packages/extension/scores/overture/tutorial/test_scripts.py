"""Pytest runner for the guided-tutorial unicycle scripts (harmoniqs/amicode#1163).

Each script is executed as a subprocess, in isolation: the bundled Research
Project template is copied into a fresh temp directory first so a run never
writes into the source tree (the scripts anchor their output directory on their
own location, not on the working directory).

Run with:  python -m pytest packages/extension/scores/overture/tutorial/test_scripts.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "project"

# script -> (output directory under experiments/, files that must exist and be non-empty)
LOOPS = {
    "01_feedforward": ("experiments/01_feedforward", ["result.json", "tracking_error.png"]),
    "02_pid": ("experiments/02_pid", ["result.json", "tracking_error.png"]),
    "03_mpc": ("experiments/03_mpc", ["result.json", "tracking_error.png"]),
}


def _copy_project(dest: Path) -> Path:
    project = dest / "project"
    shutil.copytree(
        TEMPLATE,
        project,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    return project


def _run(project: Path, name: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(project / "experiments" / f"{name}.py")],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=300,
    )


def _result(project: Path, name: str) -> dict:
    out_dir, _ = LOOPS[name]
    return json.loads((project / out_dir / "result.json").read_text())


@pytest.fixture(scope="module")
def runs(tmp_path_factory):
    """Run all three scripts once; later tests inspect the shared outcome."""
    root = tmp_path_factory.mktemp("tutorial")
    project = _copy_project(root)
    workdir = root / "elsewhere"  # a cwd that is NOT the project: scripts must not care
    workdir.mkdir()
    procs = {name: _run(project, name, workdir) for name in LOOPS}
    return project, procs


@pytest.mark.parametrize("name", list(LOOPS))
def test_script_exits_zero_and_writes_declared_outputs(runs, name):
    project, procs = runs
    proc = procs[name]
    assert proc.returncode == 0, f"{name} failed:\n{proc.stdout}\n{proc.stderr}"
    out_dir, files = LOOPS[name]
    for fname in files:
        path = project / out_dir / fname
        assert path.is_file(), f"{name}: missing {out_dir}/{fname}"
        assert path.stat().st_size > 0, f"{name}: empty {out_dir}/{fname}"


def test_feedforward_tracks_matched_start_and_drifts_when_perturbed(runs):
    project, _ = runs
    m = _result(project, "01_feedforward")["metrics"]
    assert m["matched_max_error_m"] < 1e-6
    assert m["perturbed_max_error_m"] > 0.2
    assert m["perturbed_final_error_m"] > 0.1  # open loop never corrects it


def test_pid_converges_with_visible_overshoot(runs):
    project, _ = runs
    m = _result(project, "02_pid")["metrics"]
    assert m["final_error_m"] < 0.02
    assert m["overshoot_m"] > 0.02


def test_mpc_tracks_tightly_and_respects_limits(runs):
    project, _ = runs
    r = _result(project, "03_mpc")
    m, lim = r["metrics"], r["limits"]
    assert m["final_error_m"] < 0.01
    tol = 1e-6
    assert m["max_speed"] <= lim["v_max"] + tol
    assert m["min_speed"] >= lim["v_min"] - tol
    assert m["max_abs_turn_rate"] <= lim["omega_max"] + tol
    assert m["max_accel"] <= lim["accel_max"] + tol
    assert m["max_turn_accel"] <= lim["alpha_max"] + tol


def test_mpc_settles_cleaner_than_pid(runs):
    project, _ = runs
    pid = _result(project, "02_pid")["metrics"]
    mpc = _result(project, "03_mpc")["metrics"]
    assert mpc["overshoot_m"] < pid["overshoot_m"]
    assert mpc["final_error_m"] < pid["final_error_m"]


def test_scripts_are_deterministic(tmp_path):
    """Two independent runs produce byte-identical result artifacts."""
    for name in LOOPS:
        artifacts = []
        for i in range(2):
            project = _copy_project(tmp_path / f"{name}-{i}")
            proc = _run(project, name, tmp_path)
            assert proc.returncode == 0, proc.stderr
            out_dir, _ = LOOPS[name]
            artifacts.append((project / out_dir / "result.json").read_bytes())
        assert artifacts[0] == artifacts[1], f"{name}: result.json differs between runs"


def test_template_layout():
    try:  # Python 3.11+; 3.10 needs the tomli backport
        import tomllib
    except ModuleNotFoundError:  # pragma: no cover
        tomllib = pytest.importorskip("tomli")
    manifest = tomllib.loads((TEMPLATE / "research-project.toml").read_text())
    assert manifest["schema_version"] == 1
    for key in ("name", "slug", "question", "status", "created"):
        assert manifest[key]
    env_slug = manifest["environment"]["slug"]
    env_manifest = tomllib.loads(
        (TEMPLATE / "environments" / env_slug / "research-environment.toml").read_text()
    )
    assert env_manifest["slug"] == env_slug
    assert (TEMPLATE / "README.md").is_file()
    assert (TEMPLATE / "ledger").is_dir()
    for name in LOOPS:
        assert (TEMPLATE / "experiments" / f"{name}.py").is_file()
