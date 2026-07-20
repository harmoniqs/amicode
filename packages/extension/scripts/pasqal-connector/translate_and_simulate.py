#!/usr/bin/env python3
"""Piccolo→Pulser translation spike, translate side.

Reads the knot-level pulse exported by solve_x_gate.jl (pulse.toml), builds a
validated Pulser Sequence via the shared pulse contract, and simulates it
locally with QuTiP. Reports the |g⟩→|r⟩ transfer probability (the X gate
acting on |g⟩), which should match the Piccolo solve's fidelity.

No cloud, no credentials — local simulation only.

Usage: python3 translate_and_simulate.py [path/to/pulse.toml]
"""

import sys

import numpy as np
from pulser_simulation import QutipEmulator

from pulse_contract import ContractError, build_sequence, load_knots


def simulate_transfer_probability(sequence, with_modulation: bool = False) -> float:
    """P(|r⟩) after running the sequence from |g⟩, via local QuTiP emulation."""
    emulator = QutipEmulator.from_sequence(sequence, with_modulation=with_modulation)
    final_state = emulator.run().get_final_state()
    # Ground–rydberg basis orders states (r, g): index 0 is |r⟩.
    return float(np.abs(final_state.full()[0, 0]) ** 2)


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "pulse.toml"
    try:
        data = load_knots(path)
        solve_fidelity = data.get("fidelity", float("nan"))
        print(f"Loaded {data['n_knots']} knots, dt={data['dt_ns']}ns, "
              f"solve fidelity={solve_fidelity:.8f}")
        sequence = build_sequence(data)
    except ContractError as exc:
        print(f"error: invalid pulse: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"Sequence validated against {sequence.device.name} "
          f"(duration {sequence.get_duration()}ns).")

    p_r = simulate_transfer_probability(sequence)
    print(f"P(|r⟩) after pulse from |g⟩: {p_r:.6f}")
    print(f"Piccolo predicted: {solve_fidelity:.6f}")
    print(f"Difference: {abs(p_r - solve_fidelity):.2e}")

    verdict = "PASS" if p_r > 0.99 else "FAIL"
    print(f"{verdict}: Piccolo-optimized pulse "
          f"{'transfers' if verdict == 'PASS' else 'fails to transfer'} "
          f"|g⟩→|r⟩ through Pulser on AnalogDevice.")
    sys.exit(0 if verdict == "PASS" else 1)


if __name__ == "__main__":
    main()
