#!/usr/bin/env python3
"""Piccolo→Pulser translation + local simulation gate.

Reads the knot-level pulse exported by a solve script (pulse.toml), builds a
validated Pulser Sequence via the shared pulse contract, and simulates it
locally with QuTiP — no cloud, no credentials.

Verdict vocabulary (campaign pasqal-gate-autoresearch S-14): "not a
single-atom π pulse" is NOT "bad pulse". This leg's transfer probability
P(|g⟩→|r⟩) is a single-atom metric; it cannot judge an entangler (a VALIDATED
2-atom CZ once printed FAIL here because P(|rr⟩)≈0 is correct for it). A pulse
is bad only when it violates the contract (error path) or when the emulator
DISAGREES with the recorded solve fidelity — an integration problem. A
multi-atom pulse validates with an out-of-scope note pointing at
emulate_gate_unitary.py, which carries the gate-unitary verdict leg.

Usage: python3 translate_and_simulate.py [path/to/pulse.toml]
"""

import sys

import numpy as np
from pulser_simulation import QutipEmulator

from pulse_contract import ContractError, build_sequence, load_knots

# Beyond this, the emulator and the solve integrated different pulses.
# Well-parameterized single-channel pulses agree to ~1e-6; 1e-3 is the gross
# disagreement bar (the S-10 spline artifact measured 0.125 on a jagged ZOH).
CONSISTENCY_TOL = 1e-3


def simulate_transfer_probability(sequence, with_modulation: bool = False) -> float:
    """P(|r⟩) after running the sequence from |g⟩, via local QuTiP emulation."""
    emulator = QutipEmulator.from_sequence(sequence, with_modulation=with_modulation)
    final_state = emulator.run().get_final_state()
    # Ground–rydberg basis orders states (r, g): index 0 is |r⟩. For a
    # multi-atom register index 0 is |rr…r⟩ — informational only there.
    return float(np.abs(final_state.full()[0, 0]) ** 2)


def assess_verdict(p_r: float, solve_fidelity: float, n_atoms: int) -> tuple:
    """(verdict line, exit code) — the S-14 vocabulary.

    Exit 0: sequence validated, in-scope PASS or an explicit out-of-scope
    note (never a quality FAIL for a pulse class this leg cannot measure).
    Exit 1: emulator-vs-solve disagreement — the one "bad pulse" signal this
    leg owns (an integration problem, not a pulse-quality verdict).
    """
    if n_atoms > 1:
        return (
            f"PASS: sequence validated — transfer probability is a single-atom "
            f"metric and cannot judge a {n_atoms}-atom pulse (P(|r…r⟩)={p_r:.6f} "
            "recorded as informational). Run emulate_gate_unitary.py on this "
            "pulse for the gate-unitary verdict.",
            0,
        )
    # NaN sentinel = no solve fidelity recorded: nothing to disagree with
    if (
        solve_fidelity == solve_fidelity
        and abs(p_r - solve_fidelity) > CONSISTENCY_TOL
    ):
        return (
            f"FAIL: emulator disagrees with the solve "
            f"(P(|r⟩)={p_r:.6f} vs solve fidelity={solve_fidelity:.6f}, "
            f"difference {abs(p_r - solve_fidelity):.2e} > {CONSISTENCY_TOL:g}) — "
            "this is an integration problem, not a pulse-quality verdict",
            1,
        )
    if p_r > 0.99:
        return (
            f"PASS: Piccolo-optimized pulse transfers |g⟩→|r⟩ through Pulser "
            f"on AnalogDevice (P(|r⟩)={p_r:.6f}).",
            0,
        )
    comparison = (
        f"agrees with the recorded solve fidelity {solve_fidelity:.6f}"
        if solve_fidelity == solve_fidelity
        else "no solve fidelity recorded to compare"
    )
    return (
        f"PASS: sequence validated and emulator-consistent — not a "
        f"single-atom π pulse (P(|r⟩)={p_r:.6f}, {comparison}); this leg does "
        "not judge its quality",
        0,
    )


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
    n_atoms = len(data.get("atoms", [[0, 0]]))
    print(f"Sequence validated against {sequence.device.name} "
          f"({n_atoms} atom{'s' if n_atoms > 1 else ''}, "
          f"duration {sequence.get_duration()}ns).")

    p_r = simulate_transfer_probability(sequence)
    if n_atoms == 1:
        print(f"P(|r⟩) after pulse from |g⟩: {p_r:.6f}")
        print(f"Piccolo predicted: {solve_fidelity:.6f}")
        print(f"Difference: {abs(p_r - solve_fidelity):.2e}")
    else:
        # informational only: for an entangler this is P(|rr…r⟩), not a
        # fidelity — the gate verdict lives in emulate_gate_unitary.py
        print(f"P(|r…r⟩) after pulse from all-ground (informational): {p_r:.6f}")

    verdict, exit_code = assess_verdict(p_r, solve_fidelity, n_atoms)
    print(verdict)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()