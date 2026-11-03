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
import math
import sys
import unittest
import warnings
from pathlib import Path

SPIKE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPIKE_DIR))

import pulser  # noqa: E402

from pulse_contract import (  # noqa: E402
    ContractError,
    DUST_TOL,
    NonIdleEndpointsWarning,
    build_sequence,
    load_knots,
    validate_against_device,
    validate_schema,
    warn_non_idle_endpoints,
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




class TestIdleEndpoints(unittest.TestCase):
    """S-19/S-20 (campaign pasqal-gate-autoresearch): a pulse that does not
    return both drives to idle (Ω=Δ=0) at its endpoints is an incomplete
    hardware gate. The contract WARNS, never rejects — existing valid pulses
    keep validating. H17 measured that clamping costs nothing and pays on
    both legs (ΔF_emu +4.7e-5/+1.7e-3, ΔF_mod +0.039/+2.3e-3)."""

    def corrupt(self, **changes):
        data = copy.deepcopy(golden())
        data.update(changes)
        return data

    def build_catching_warnings(self, data):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            seq = build_sequence(data)
        idle = [w for w in caught if issubclass(w.category, NonIdleEndpointsWarning)]
        return seq, idle

    def test_golden_fixture_is_idle_ended(self):
        # The committed Jul-8 X-gate solve converged to idle endpoints, so
        # it must sail through with NO warning — a clamped pulse validates clean.
        seq, idle = self.build_catching_warnings(golden())
        self.assertEqual(seq.get_duration(), 400)
        self.assertEqual(idle, [])

    def test_non_idle_endpoints_warn_but_validate(self):
        data = self.corrupt()
        data["amplitude"][0] = 5.0
        data["amplitude"][-1] = 4.0
        data["detuning"][-1] = 57.0
        seq, idle = self.build_catching_warnings(data)
        # warn, never reject: the pulse still validates and builds
        self.assertEqual(seq.get_duration(), 400)
        self.assertEqual(len(idle), 1)
        msg = str(idle[0].message)
        self.assertIn("amplitude[0]", msg)
        self.assertIn("amplitude[100]", msg)
        self.assertIn("detuning[100]", msg)

    def test_one_sided_endpoint_still_warns(self):
        data = self.corrupt()
        data["detuning"][0] = -0.17
        seq, idle = self.build_catching_warnings(data)
        self.assertEqual(seq.get_duration(), 400)
        self.assertEqual(len(idle), 1)
        self.assertIn("detuning[0]", str(idle[0].message))

    def test_dust_level_endpoints_count_as_idle(self):
        data = self.corrupt()
        data["amplitude"][0] = DUST_TOL / 10
        data["detuning"][-1] = -DUST_TOL / 10
        seq, idle = self.build_catching_warnings(data)
        self.assertEqual(seq.get_duration(), 400)
        self.assertEqual(idle, [])

    def test_standalone_call_ignores_malformed_arrays(self):
        # public helper must not explode on dicts that fail schema validation
        # elsewhere — structural validation reports those with its own errors
        warn_non_idle_endpoints({"amplitude": "junk", "detuning": None})
        warn_non_idle_endpoints({})


class TestAtomsKey(unittest.TestCase):
    """Additive `atoms` register key: absent = single atom (back-compat)."""

    def corrupt(self, **changes):
        data = copy.deepcopy(golden())
        data.update(changes)
        return data

    def test_absent_atoms_builds_single_atom(self):
        seq = build_sequence(golden())  # golden has no atoms key
        self.assertEqual(len(seq.register.qubits), 1)

    def test_two_atom_register_builds(self):
        seq = build_sequence(self.corrupt(atoms=[[0.0, 0.0], [5.0, 0.0]]))
        self.assertEqual(len(seq.register.qubits), 2)

    def test_below_min_distance_raises(self):
        with self.assertRaises(ContractError) as ctx:
            build_sequence(self.corrupt(atoms=[[0.0, 0.0], [3.0, 0.0]]))
        self.assertIn("minimum atom distance", str(ctx.exception))

    def test_too_many_atoms_raises(self):
        atoms = [[float(6 * i), float(6 * j)] for i in range(10) for j in range(10)]
        with self.assertRaises(ContractError) as ctx:
            build_sequence(self.corrupt(atoms=atoms))
        self.assertIn("max atom number", str(ctx.exception))

    def test_malformed_atoms_raise(self):
        for bad in ([], [[0.0]], [[0.0, float("nan")]], [["x", 0.0]], "atoms"):
            with self.assertRaises(ContractError):
                validate_schema(self.corrupt(atoms=bad))


def calibrated_triangle(layout) -> list:
    """Three mutually adjacent traps of a triangular-lattice layout, as the
    [x, y] pairs a solver would write into `atoms` (trap coordinates as-is)."""
    coords = [tuple(float(c) for c in row) for row in layout.coords]
    spacing = min(
        math.dist(a, b) for i, a in enumerate(coords) for b in coords[i + 1:]
    )

    def adjacent(a, b):
        return abs(math.dist(a, b) - spacing) < 1e-3

    centre = min(coords, key=lambda c: math.hypot(*c))
    near = [c for c in coords if adjacent(centre, c)]
    for b in near:
        for c in near:
            if b < c and adjacent(b, c):
                return [list(centre), list(b), list(c)]
    raise AssertionError("no triangle found in layout")


class TestMinDistanceTolerance(unittest.TestCase):
    """The distance check must use Pulser's own coordinate-precision tolerance
    (10^-COORD_PRECISION), not a strict `<` (harmoniqs/amicode#1854)."""

    def corrupt(self, **changes):
        data = copy.deepcopy(golden())
        data.update(changes)
        return data

    def test_rounded_calibrated_spacing_passes(self):
        # 4.9999999836 µm: the calibrated layout's 5 µm spacing after the
        # layout's coordinate rounding. Pulser accepts it; so must we.
        atoms = [[0.0, 0.0], [4.9999999836, 0.0], [2.4999999918, 4.330127]]
        validate_against_device(self.corrupt(atoms=atoms))
        seq = build_sequence(self.corrupt(atoms=atoms))
        self.assertEqual(len(seq.register.qubits), 3)

    def test_calibrated_layout_triangle_coordinates_pass(self):
        layout = pulser.AnalogDevice.pre_calibrated_layouts[0]
        validate_against_device(self.corrupt(atoms=calibrated_triangle(layout)))

    def test_just_inside_tolerance_passes_just_outside_fails(self):
        validate_against_device(self.corrupt(atoms=[[0.0, 0.0], [5.0 - 5e-7, 0.0]]))
        with self.assertRaises(ContractError) as ctx:
            validate_against_device(self.corrupt(atoms=[[0.0, 0.0], [5.0 - 2e-6, 0.0]]))
        self.assertIn("minimum atom distance", str(ctx.exception))

    def test_genuinely_too_close_still_rejected(self):
        with self.assertRaises(ContractError) as ctx:
            build_sequence(self.corrupt(atoms=[[0.0, 0.0], [4.9, 0.0]]))
        self.assertIn("minimum atom distance", str(ctx.exception))


class TestLayoutKeptThroughContract(unittest.TestCase):
    """Additive `layout` key: the built register keeps its RegisterLayout."""

    def setUp(self):
        self.device = pulser.AnalogDevice
        self.layout = self.device.pre_calibrated_layouts[0]
        self.atoms = calibrated_triangle(self.layout)

    def corrupt(self, **changes):
        data = copy.deepcopy(golden())
        data.update(changes)
        return data

    def test_layout_register_keeps_calibrated_layout(self):
        seq = build_sequence(self.corrupt(atoms=self.atoms, layout="calibrated"))
        reg = seq.register
        self.assertIsNotNone(reg.layout)
        self.assertEqual(reg.layout, self.layout)
        self.assertEqual(len(reg.qubits), 3)
        self.assertTrue(self.device.register_is_from_calibrated_layout(reg))

    def test_layout_selectable_by_calibrated_layout_name(self):
        name = str(self.layout)
        seq = build_sequence(self.corrupt(atoms=self.atoms, layout=name))
        self.assertEqual(seq.register.layout, self.layout)

    def test_atoms_snap_to_layout_trap_coordinates(self):
        # solver-written coordinates carry float dust; the layout's traps win
        dusty = [[x + 1e-8, y - 1e-8] for x, y in self.atoms]
        seq = build_sequence(self.corrupt(atoms=dusty, layout="calibrated"))
        traps = {tuple(map(float, row)) for row in self.layout.coords}
        for pos in seq.register.qubits.values():
            self.assertIn(tuple(float(c) for c in pos), traps)

    def test_no_layout_key_keeps_layoutless_register(self):
        seq = build_sequence(self.corrupt(atoms=self.atoms))
        self.assertIsNone(seq.register.layout)

    def test_atom_off_the_layout_raises(self):
        with self.assertRaises(ContractError) as ctx:
            build_sequence(self.corrupt(atoms=[[0.0, 0.0], [7.5, 0.0]], layout="calibrated"))
        self.assertIn("trap", str(ctx.exception))

    def test_unknown_layout_name_raises(self):
        with self.assertRaises(ContractError) as ctx:
            build_sequence(self.corrupt(atoms=self.atoms, layout="NoSuchLayout"))
        self.assertIn("calibrated", str(ctx.exception))

    def test_layout_without_atoms_is_a_schema_error(self):
        with self.assertRaises(ContractError):
            validate_schema(self.corrupt(layout="calibrated"))

    def test_malformed_layout_raises(self):
        for bad in ("", 3, ["calibrated"]):
            with self.assertRaises(ContractError):
                validate_schema(self.corrupt(atoms=self.atoms, layout=bad))

    def test_too_close_atoms_on_layout_still_rejected(self):
        # two atoms on the SAME trap are 0 µm apart: distance error, not a snap
        atoms = [self.atoms[0], self.atoms[0]]
        with self.assertRaises(ContractError) as ctx:
            build_sequence(self.corrupt(atoms=atoms, layout="calibrated"))
        self.assertIn("minimum atom distance", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
