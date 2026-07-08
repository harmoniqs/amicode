#!/usr/bin/env python3
"""Piccolo→Pulser translation spike, translate side.

Reads the knot-level pulse exported by solve_x_gate.jl (pulse.toml), builds a
Pulser Sequence on AnalogDevice via zero-order hold onto the 1 ns sample grid,
validates it against the device's constraints, and simulates it locally with
QuTiP. Reports the |g⟩→|r⟩ transfer probability (the X gate acting on |g⟩),
which should match the Piccolo solve's fidelity.

No cloud, no credentials — local simulation only.

Usage: python3 translate_and_simulate.py [path/to/pulse.toml]
"""

import sys
import tomllib

import numpy as np
import pulser
from pulser_simulation import QutipEmulator


def load_knots(path: str) -> dict:
    with open(path, "rb") as f:
        data = tomllib.load(f)
    if data.get("units") != "rad/us":
        raise ValueError(f"expected rad/us units, got {data.get('units')!r}")
    return data


def zero_order_hold(knots: list[float], dt_ns: float) -> np.ndarray:
    """Expand N knot values (N-1 intervals of dt_ns each) to 1 ns samples."""
    per_knot = int(round(dt_ns))
    return np.repeat(np.asarray(knots[:-1]), per_knot)


def build_sequence(data: dict) -> pulser.Sequence:
    channel = pulser.AnalogDevice.channels["rydberg_global"]

    amp = zero_order_hold(data["amplitude"], data["dt_ns"])
    det = zero_order_hold(data["detuning"], data["dt_ns"])

    # The solve already respects device bounds; clip only the numerical dust
    # (e.g. -1e-12 from the optimizer sitting on the amplitude lower bound).
    amp = np.clip(amp, 0.0, channel.max_amp)
    det = np.clip(det, -channel.max_abs_detuning, channel.max_abs_detuning)

    register = pulser.Register.from_coordinates([(0, 0)], prefix="q")
    sequence = pulser.Sequence(register, pulser.AnalogDevice)
    sequence.declare_channel("rydberg_global", "rydberg_global")
    pulse = pulser.Pulse(
        pulser.CustomWaveform(amp),
        pulser.CustomWaveform(det),
        phase=0.0,
    )
    sequence.add(pulse, "rydberg_global")
    sequence.measure()
    return sequence


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "pulse.toml"
    data = load_knots(path)
    print(f"Loaded {data['n_knots']} knots, dt={data['dt_ns']}ns, "
          f"solve fidelity={data['fidelity']:.8f}")

    sequence = build_sequence(data)  # raises if the device rejects the pulse
    print(f"Sequence validated against {sequence.device.name} "
          f"(duration {sequence.get_duration()}ns).")

    emulator = QutipEmulator.from_sequence(sequence)
    result = emulator.run()
    final_state = result.get_final_state()

    # Ground–rydberg basis orders states (r, g): index 0 is |r⟩.
    p_r = float(np.abs(final_state.full()[0, 0]) ** 2)
    print(f"P(|r⟩) after pulse from |g⟩: {p_r:.6f}")
    print(f"Piccolo predicted: {data['fidelity']:.6f}")
    print(f"Difference: {abs(p_r - data['fidelity']):.2e}")

    verdict = "PASS" if p_r > 0.99 else "FAIL"
    print(f"{verdict}: Piccolo-optimized pulse "
          f"{'transfers' if verdict == 'PASS' else 'fails to transfer'} "
          f"|g⟩→|r⟩ through Pulser on AnalogDevice.")
    sys.exit(0 if verdict == "PASS" else 1)


if __name__ == "__main__":
    main()
