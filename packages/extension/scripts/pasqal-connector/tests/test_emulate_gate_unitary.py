"""S-5/S-10/S-13 (campaign pasqal-gate-autoresearch): the gate-unitary
verification leg, ported from the campaign's validated emulate_gate_unitary.py
(h1 stage 3 — validated to 1.2e-5 emulator-vs-Julia-rollout consistency; the
unitary-level machinery self-checked to ‖U−exact‖∞ = 1.6e-6).

No QutipEmulator.run() is trusted for jagged ZOH pulses: qutip 5's
array-coefficient default is a CUBIC SPLINE, so pulser_simulation integrates a
splined waveform, not the contract's staircase (S-10 — a measured 0.125
consistency gap on this very fixture's class). The ported path rebuilds the
emulator's own Hamiltonian with coefficient(order=0) and sesolves each basis
ket. The trailing-zero restore (S-13) undoes the zero sample pulser's
sampler appends at t=T, which an order=0 consumer would otherwise integrate
as a final 1-ns dead interval.
"""

import sys
import unittest
from pathlib import Path

import numpy as np

SPIKE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPIKE_DIR))

from pulse_contract import (  # noqa: E402
    NonIdleEndpointsWarning,
    build_sequence,
    load_knots,
)
from emulate_gate_unitary import (  # noqa: E402
    emulator_unitary_step,
    free_phase_fidelities,
    restore_trailing_zero_sample,
)

CZ_GOLDEN = Path(__file__).resolve().parent / "fixtures" / "pulse_cz_golden.toml"


class TestTrailingZeroRestore(unittest.TestCase):
    """S-13: pulser's samples_obj appends a trailing zero sample at t=T."""

    def test_appended_zero_is_restored_to_last_held(self):
        amp = np.array([1.0, 2.0, 3.0, 0.0])
        det = np.array([0.5, 0.5, 0.5, 0.0])
        phase = np.array([0.0, 0.0, 0.0, 0.0])
        a, d, p = restore_trailing_zero_sample(amp, det, phase)
        # the contract plays knots[:-1] for dt each: last-held value is [-2]
        np.testing.assert_allclose(a, [1.0, 2.0, 3.0, 3.0])
        np.testing.assert_allclose(d, [0.5, 0.5, 0.5, 0.5])
        np.testing.assert_allclose(p, [0.0, 0.0, 0.0, 0.0])

    def test_idle_ending_pulse_restore_is_a_no_op(self):
        # a genuinely idle-ending pulse has samples[-2] == 0 too: restoring
        # copies the zero back — same waveform, no distortion
        amp = np.array([1.0, 0.0, 0.0])
        det = np.array([0.0, 0.0, 0.0])
        a, d, _ = restore_trailing_zero_sample(amp, det, np.zeros(3))
        np.testing.assert_allclose(a, [1.0, 0.0, 0.0])

    def test_no_restore_when_last_sample_is_live(self):
        amp = np.array([1.0, 2.0, 3.0])
        det = np.array([1.0, 0.0, 0.0])
        a, d, _ = restore_trailing_zero_sample(amp, det, np.zeros(3))
        np.testing.assert_allclose(a, amp)
        np.testing.assert_allclose(d, det)


class TestCampaignRegression(unittest.TestCase):
    """The ported leg must reproduce the campaign's recorded, adjudicated
    numbers on the campaign's own validated pulse (h1 attempt (b))."""

    def test_cz_fixture_reproduces_validated_numbers(self):
        data = load_knots(str(CZ_GOLDEN))
        # S-19: the campaign pulse ends mid-drive (det[-1] = 57.8 rad/µs) —
        # the contract must WARN on it, and validate anyway
        with self.assertWarns(NonIdleEndpointsWarning):
            sequence = build_sequence(data)
        self.assertEqual(sequence.get_duration(), 960)

        U, gg_gap = emulator_unitary_step(sequence, with_modulation=False)
        unitarity = float(np.linalg.norm(U.conj().T @ U - np.eye(4), np.inf))
        self.assertLess(unitarity, 1e-5)

        f_fixed, f_free, theta_star = free_phase_fidelities(U)
        # recorded in runs/h1/cz_b/emu_results.json (order=0 ZOH leg)
        self.assertAlmostEqual(f_fixed, 0.37102565593412873, places=5)
        self.assertAlmostEqual(f_free, 0.9990173718245104, places=5)
        self.assertAlmostEqual(theta_star[0], 1.348266847165619, places=4)
        self.assertAlmostEqual(theta_star[1], 1.348266847165619, places=4)
        # θ₁=θ₂ invariant: swap-symmetric drives force the free-phase optimum
        # onto the diagonal (measured swap gap 1.6e-6) — cheap sanity check
        self.assertAlmostEqual(theta_star[0], theta_star[1], places=6)
        # S-10 tripwire: emu.run() (splined by qutip 5's default) disagrees
        # MATERIALLY with the ZOH staircase on this jagged pulse. If this
        # assertion ever fails small, pulser/qutip changed the default
        # integration order and every order=0 consumer must be re-checked.
        self.assertGreater(gg_gap, 0.1)


if __name__ == "__main__":
    unittest.main()