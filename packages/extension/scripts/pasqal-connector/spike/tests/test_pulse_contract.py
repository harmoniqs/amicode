"""Harness for the Piccolo→Pulser pulse contract (stdlib unittest, no pytest).

Three tiers:
  1. This file — fast, hermetic: no network, no Julia, no credentials.
     Validates the contract against the committed golden fixture (a real
     seeded solve output) and a battery of corrupted variants.
  2. test_cli.py — script-level behavior (exit codes, --dry-run, stderr).
  3. slow_e2e.py — opt-in: re-runs the Julia solve and checks agreement.

Run from the spike directory:
    python3 -m unittest discover -s tests -v
"""

import copy
import sys
import unittest
from pathlib import Path

SPIKE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPIKE_DIR))

import pulser  # noqa: E402

from pulse_contract import (  # noqa: E402
    ContractError,
    DUST_TOL,
    build_sequence,
    load_knots,
    validate_schema,
    zero_order_hold,
)

GOLDEN = Path(__file__).resolve().parent / "fixtures" / "pulse_golden.toml"
CHANNEL = pulser.AnalogDevice.channels["rydberg_global"]


def golden() -> dict:
    return load_knots(str(GOLDEN))


class TestGoldenFixture(unittest.TestCase):
    """The committed real-solve output must sail through every layer."""

    def test_loads_and_validates(self):
        data = golden()
        self.assertEqual(data["n_knots"], 101)
        self.assertEqual(data["dt_ns"], 4.0)
        self.assertGreater(data["fidelity"], 0.999)

    def test_zero_order_hold_shape(self):
        data = golden()
        samples = zero_order_hold(data["amplitude"], data["dt_ns"])
        self.assertEqual(len(samples), (data["n_knots"] - 1) * 4)
        # ZOH means each knot value appears in a run of dt consecutive samples
        self.assertEqual(samples[0], data["amplitude"][0])
        self.assertEqual(samples[3], data["amplitude"][0])
        self.assertEqual(samples[4], data["amplitude"][1])

    def test_builds_validated_sequence(self):
        seq = build_sequence(golden())
        self.assertEqual(seq.get_duration(), 400)
        self.assertEqual(seq.device.name, "AnalogDevice")


class TestSchemaRejections(unittest.TestCase):
    """Every structural corruption must raise ContractError with a clear message."""

    def corrupt(self, **changes):
        data = copy.deepcopy(golden())
        data.update(changes)
        return data

    def assert_rejected(self, data, fragment):
        with self.assertRaises(ContractError) as ctx:
            validate_schema(data)
        self.assertIn(fragment, str(ctx.exception))

    def test_missing_schema_version(self):
        data = self.corrupt()
        del data["schema_version"]
        self.assert_rejected(data, "schema_version")

    def test_wrong_schema_version(self):
        self.assert_rejected(self.corrupt(schema_version=2), "schema_version")

    def test_wrong_units(self):
        self.assert_rejected(self.corrupt(units="MHz"), "units")

    def test_bad_dt(self):
        for dt in (0, -4.0, float("nan"), float("inf"), "4"):
            self.assert_rejected(self.corrupt(dt_ns=dt), "dt_ns")

    def test_bad_n_knots(self):
        for n in (1, 0, -5, 2.5, "101"):
            self.assert_rejected(self.corrupt(n_knots=n), "n_knots")

    def test_length_mismatch(self):
        data = self.corrupt()
        data["amplitude"] = data["amplitude"][:-1]
        self.assert_rejected(data, "amplitude")

    def test_non_finite_values(self):
        for bad in (float("nan"), float("inf")):
            data = self.corrupt()
            data["detuning"][50] = bad
            self.assert_rejected(data, "detuning")

    def test_bad_fidelity(self):
        self.assert_rejected(self.corrupt(fidelity=1.5), "fidelity")

    def test_unknown_keys_ignored(self):
        validate_schema(self.corrupt(some_future_field="ok"))  # additive policy


class TestDeviceRejections(unittest.TestCase):
    """Device-limit violations must raise, not clip."""

    def corrupt(self, **changes):
        data = copy.deepcopy(golden())
        data.update(changes)
        return data

    def assert_rejected(self, data, fragment):
        with self.assertRaises(ContractError) as ctx:
            build_sequence(data)
        self.assertIn(fragment, str(ctx.exception))

    def test_amplitude_violation_raises_not_clips(self):
        data = self.corrupt()
        data["amplitude"][50] = 2 * CHANNEL.max_amp  # a genuinely bad solve
        self.assert_rejected(data, "amplitude[50]")

    def test_negative_amplitude_violation(self):
        data = self.corrupt()
        data["amplitude"][10] = -1.0
        self.assert_rejected(data, "amplitude[10]")

    def test_amplitude_dust_is_clipped_silently(self):
        data = self.corrupt()
        data["amplitude"][0] = -DUST_TOL / 10  # optimizer bound-riding dust
        seq = build_sequence(data)  # must NOT raise
        self.assertEqual(seq.get_duration(), 400)

    def test_detuning_violation(self):
        data = self.corrupt()
        data["detuning"][3] = 2 * CHANNEL.max_abs_detuning
        self.assert_rejected(data, "detuning[3]")

    def test_dt_off_clock_grid(self):
        self.assert_rejected(self.corrupt(dt_ns=3.0), "clock")

    def test_too_short(self):
        data = self.corrupt(n_knots=4)  # 3 intervals × 4 ns = 12 ns < 16 ns min
        data["amplitude"] = data["amplitude"][:4]
        data["detuning"] = data["detuning"][:4]
        self.assert_rejected(data, "minimum")

    def test_too_long_for_device(self):
        n = 2000  # 1999 × 4 ns ≈ 8 µs > 6 µs device max
        data = self.corrupt(n_knots=n)
        data["amplitude"] = [1.0] * n
        data["detuning"] = [0.0] * n
        self.assert_rejected(data, "max sequence")

    def test_unknown_channel(self):
        with self.assertRaises(ContractError) as ctx:
            build_sequence(golden(), channel_name="no_such_channel")
        self.assertIn("no channel", str(ctx.exception))


class TestGoldenSimulation(unittest.TestCase):
    """Physics regression: the golden pulse must still do its job in QuTiP."""

    def test_transfer_probability_matches_solve(self):
        from translate_and_simulate import simulate_transfer_probability

        data = golden()
        p_r = simulate_transfer_probability(build_sequence(data))
        self.assertGreater(p_r, 0.999)
        self.assertLess(abs(p_r - data["fidelity"]), 1e-4)

    def test_survives_output_modulation(self):
        from translate_and_simulate import simulate_transfer_probability

        seq = build_sequence(golden())
        p_r = simulate_transfer_probability(seq, with_modulation=True)
        self.assertGreater(p_r, 0.999)  # 8 MHz filter must not break the gate


if __name__ == "__main__":
    unittest.main()
