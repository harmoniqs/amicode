"""S-14 (campaign pasqal-gate-autoresearch): translate_and_simulate's verdict
vocabulary must distinguish "not a single-atom π pulse" from "bad pulse".

The live hit: a VALIDATED 2-atom CZ pulse printed FAIL because its P(|r⟩)
single-atom transfer verdict has no meaning for an entangler — any exit-code
consumer rejected every multi-qubit gate. The fix: a pulse is BAD only when
it violates the contract (error path) or when the emulator DISAGREES with the
solve (an integration problem); an out-of-scope pulse class validates clean.

Also runs the script end-to-end on the campaign's validated CZ fixture: an
entangler must validate without FAIL.
"""

import math
import os
import subprocess
import sys
import unittest
from pathlib import Path

SPIKE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPIKE_DIR))

from translate_and_simulate import (  # noqa: E402
    CONSISTENCY_TOL,
    assess_verdict,
)

CZ_GOLDEN = Path(__file__).resolve().parent / "fixtures" / "pulse_cz_golden.toml"


class TestVerdictVocabulary(unittest.TestCase):
    def test_entangler_validates_without_fail(self):
        verdict, exit_code = assess_verdict(p_r=0.000123, solve_fidelity=0.999, n_atoms=2)
        self.assertEqual(exit_code, 0)
        self.assertNotIn("FAIL", verdict)
        self.assertIn("PASS", verdict)
        # the out-of-scope note must point at the gate-unitary leg
        self.assertIn("emulate_gate_unitary", verdict)

    def test_single_atom_pi_pulse_passes(self):
        verdict, exit_code = assess_verdict(p_r=0.99999, solve_fidelity=0.99999999, n_atoms=1)
        self.assertEqual(exit_code, 0)
        self.assertIn("PASS", verdict)
        self.assertNotIn("FAIL", verdict)

    def test_consistent_but_not_a_pi_pulse_is_not_bad(self):
        # emulator agrees with the recorded solve; the pulse just isn't a π
        # transfer — validated, consistent, class out of scope: no FAIL
        verdict, exit_code = assess_verdict(p_r=0.0391, solve_fidelity=0.039, n_atoms=1)
        self.assertEqual(exit_code, 0)
        self.assertNotIn("FAIL", verdict)
        self.assertIn("not a single-atom π pulse", verdict)

    def test_emulator_disagreement_with_solve_fails(self):
        # P(|r⟩)=0.99999 while the solve recorded 0.5 — the emulator and the
        # solver integrate DIFFERENT pulses: the one real "bad" signal here
        verdict, exit_code = assess_verdict(p_r=0.99999, solve_fidelity=0.5, n_atoms=1)
        self.assertEqual(exit_code, 1)
        self.assertIn("FAIL", verdict)
        self.assertIn("integration problem", verdict)
        self.assertGreater(CONSISTENCY_TOL, 0.0)

    def test_disagreement_just_over_tolerance(self):
        verdict, exit_code = assess_verdict(p_r=0.5, solve_fidelity=0.5 + 2 * CONSISTENCY_TOL, n_atoms=1)
        self.assertEqual(exit_code, 1)

    def test_agreement_within_tolerance_is_not_a_failure(self):
        verdict, exit_code = assess_verdict(p_r=0.5, solve_fidelity=0.5 + CONSISTENCY_TOL / 2, n_atoms=1)
        self.assertEqual(exit_code, 0)

    def test_absent_solve_fidelity_skips_consistency(self):
        # no fidelity recorded: nothing to disagree with; verdict on scope only
        verdict, exit_code = assess_verdict(p_r=0.4, solve_fidelity=float("nan"), n_atoms=1)
        self.assertEqual(exit_code, 0)
        self.assertNotIn("FAIL", verdict)
        self.assertIn("not a single-atom π pulse", verdict)
        self.assertTrue(math.isnan(float("nan")))  # guard: NaN sentinel contract


class TestEntanglerEndToEnd(unittest.TestCase):
    """The S-14 live case, through the real script: the campaign's validated
    CZ pulse must validate, emulate, and exit 0 with NO FAIL anywhere."""

    def test_cz_fixture_validates_without_fail(self):
        result = subprocess.run(
            [sys.executable, str(SPIKE_DIR / "translate_and_simulate.py"), str(CZ_GOLDEN)],
            capture_output=True, text=True, timeout=600,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("FAIL", result.stdout)
        self.assertIn("PASS", result.stdout)
        self.assertIn("emulate_gate_unitary", result.stdout)
        # the fixture ends mid-drive (S-19): the contract warning must surface
        self.assertIn("idle", result.stderr.lower())


if __name__ == "__main__":
    unittest.main()