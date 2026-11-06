"""Pytest runner for the unicycle tutorial scripts (harmoniqs/amicode#1163).

Each script runs as a subprocess in an isolated temporary working directory,
so the artifacts it writes land in that directory's ``experiments/<loop>/``
tree -- the same layout the tutorial Research Project presents.
"""

import subprocess
import sys
from pathlib import Path

import pytest

TUTORIAL_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TUTORIAL_DIR / "scripts"

# (script file, loop directory it writes into)
SCRIPTS = [
    ("01_feedforward.py", "01_feedforward"),
    ("02_pid.py", "02_pid"),
    ("03_mpc.py", "03_mpc"),
]

RESULT_NAME = "result.json"
PLOT_NAME = "tracking_error.png"


def _run(script: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script)],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=120,
    )


@pytest.mark.parametrize("script,loop", SCRIPTS)
def test_script_exits_zero_and_writes_artifacts(tmp_path, script, loop):
    proc = _run(script, tmp_path)
    assert proc.returncode == 0, f"{script} failed:\n{proc.stderr}"

    out_dir = tmp_path / "experiments" / loop
    for name in (RESULT_NAME, PLOT_NAME):
        artifact = out_dir / name
        assert artifact.is_file(), f"{script} did not write {artifact}"
        assert artifact.stat().st_size > 0, f"{artifact} is empty"


@pytest.mark.parametrize("script,loop", SCRIPTS)
def test_script_output_is_deterministic(tmp_path, script, loop):
    first = tmp_path / "run_a"
    second = tmp_path / "run_b"
    first.mkdir()
    second.mkdir()

    assert _run(script, first).returncode == 0
    assert _run(script, second).returncode == 0

    result_a = (first / "experiments" / loop / RESULT_NAME).read_bytes()
    result_b = (second / "experiments" / loop / RESULT_NAME).read_bytes()
    assert result_a == result_b, f"{script} result artifact differs between runs"
