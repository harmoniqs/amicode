#!/usr/bin/env python3
"""pasqal-mis device-sim stage: waveforms.json -> Pulser sequence -> local emulator.

Reads the `waveforms.json` the solve stage wrote next to it (times, optimized
global Omega/delta waveforms in rad/us, atom positions in um) and:

  1. builds a Pulser Register from the positions,
  2. builds a Sequence on the global Rydberg channel with the optimized
     waveforms (InterpolatedWaveform),
  3. runs the local emulator (pulser-simulation / QuTiP backend) and prints
     sampled bitstring counts, flagging the MIS bitstring.

Degraded modes (honest, never a dead end):
  - pulser not installed  -> prints the one-line install and exits 2.
  - Pasqal Cloud (EMU-MPS / Fresnel QPU) -> NOT wired in this build; submission
    requires API credentials. This script is the local light-gate check only.

Usage:  python3 register.py [path/to/waveforms.json]   (default: ./waveforms.json)
"""
import json
import sys
from pathlib import Path

wf_path = Path(sys.argv[1] if len(sys.argv) > 1 else "waveforms.json")
if not wf_path.exists():
    sys.exit(f"no {wf_path} — run the solve stage first (it writes waveforms.json)")

wf = json.loads(wf_path.read_text())
times_us = wf["times_us"]
omega = wf["omega_rad_us"]  # rad/us
delta = wf["delta_rad_us"]  # rad/us
positions = wf["positions_um"]
mis_bitstring = wf["mis_bitstring"]
duration_ns = int(round(times_us[-1] * 1000))

try:
    import numpy as np
    from pulser import Pulse, Register, Sequence
    from pulser.devices import MockDevice
    from pulser.waveforms import InterpolatedWaveform
except ImportError:
    print("Pulser is not installed. To run the emulator check locally:")
    print("    pip install pulser pulser-simulation")
    print(f"(waveforms are ready in {wf_path} — nothing is lost)")
    sys.exit(2)

# Pulser wants rad/us for amplitude/detuning and ns for durations — our units
# already match; clamp tiny negative Omega from interpolation noise.
reg = Register({f"q{i}": pos for i, pos in enumerate(positions)})
seq = Sequence(reg, MockDevice)
seq.declare_channel("global", "rydberg_global")
amp = InterpolatedWaveform(duration_ns, [max(0.0, v) for v in omega])
det = InterpolatedWaveform(duration_ns, delta)
seq.add(Pulse(amp, det, 0.0), "global")
seq.measure("ground-rydberg")

try:
    from pulser_simulation import QutipEmulator
except ImportError:
    print("pulser-simulation is not installed — sequence built OK; to emulate:")
    print("    pip install pulser-simulation")
    sys.exit(2)

sim = QutipEmulator.from_sequence(seq)
result = sim.run()
counts = result.sample_final_state(N_samples=1000)

print(f"register: {len(positions)} atoms; sweep {times_us[-1]:.2f} us; 1000 shots")
print(f"target MIS bitstring (atom 0 = leftmost): {mis_bitstring[::-1]}")
top = sorted(counts.items(), key=lambda kv: -kv[1])[:8]
for bits, c in top:
    tag = "  <-- MIS" if bits == mis_bitstring[::-1] else ""
    print(f"  {bits}: {c}{tag}")
mis_hits = counts.get(mis_bitstring[::-1], 0)
print(f"P(MIS) ~= {mis_hits / 1000:.3f}  (emulator, sampled)")
print("NOTE: Pasqal Cloud / QPU submission is not wired in this build (needs API credentials).")
