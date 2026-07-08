#!/usr/bin/env python3
"""Tier-3 opt-in E2E: fresh Julia solve → contract → simulation agreement.

Not part of `unittest discover` (no test_ prefix) — it takes minutes and
needs Julia. Mirrors the repo's AMICO_TEST_JULIA_PROJECT convention:

    AMICO_TEST_JULIA_PROJECT=$HOME/.amico/julia python3 tests/slow_e2e.py

Checks the fresh solve (not the committed fixture): fidelity ≥ 0.999,
contract acceptance, and solve↔simulation agreement < 1e-4. Catches drift
between the Julia exporter and the Python contract that fixture-only tests
cannot see.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

SPIKE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPIKE_DIR))


def main() -> None:
    julia_project = os.environ.get("AMICO_TEST_JULIA_PROJECT", "")
    if not julia_project:
        print("SKIP: set AMICO_TEST_JULIA_PROJECT to run the slow E2E gate")
        sys.exit(0)

    from pulse_contract import build_sequence, load_knots
    from translate_and_simulate import simulate_transfer_probability

    with tempfile.TemporaryDirectory() as rundir:
        print("Running fresh Julia solve (1–3 min)...")
        solve = subprocess.run(
            ["julia", f"--project={julia_project}", str(SPIKE_DIR / "solve_x_gate.jl")],
            cwd=rundir, capture_output=True, text=True, timeout=900,
        )
        if solve.returncode != 0:
            print(f"FAIL: solve exited {solve.returncode}\n{solve.stdout[-2000:]}\n{solve.stderr[-2000:]}")
            sys.exit(1)
        print(solve.stdout.strip().splitlines()[-1])

        data = load_knots(str(Path(rundir) / "pulse.toml"))
        if data["fidelity"] < 0.999:
            print(f"FAIL: fresh solve fidelity {data['fidelity']} < 0.999")
            sys.exit(1)

        sequence = build_sequence(data)  # ContractError here = exporter/contract drift
        p_r = simulate_transfer_probability(sequence)
        gap = abs(p_r - data["fidelity"])
        print(f"solve={data['fidelity']:.8f}  sim={p_r:.8f}  gap={gap:.2e}")
        if gap > 1e-4:
            print("FAIL: solve↔simulation agreement worse than 1e-4")
            sys.exit(1)

    print("PASS: fresh solve → contract → simulation all agree")


if __name__ == "__main__":
    main()
