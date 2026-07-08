"""Script-level harness: exit codes, --dry-run, credential guards.

Runs the actual CLI entry points as subprocesses — what Amico invokes via
bash is exactly what gets tested. Hermetic: no network calls succeed here
(credentials are absent or the run stops before submission).
"""

import subprocess
import sys
import unittest
from pathlib import Path

SPIKE_DIR = Path(__file__).resolve().parent.parent
GOLDEN = Path(__file__).resolve().parent / "fixtures" / "pulse_golden.toml"


def run_script(script: str, *args: str, env_extra: dict | None = None) -> subprocess.CompletedProcess:
    import os

    env = {k: v for k, v in os.environ.items()
           if not k.startswith("PASQAL_")}  # never inherit real credentials
    env.update(env_extra or {})
    return subprocess.run(
        [sys.executable, str(SPIKE_DIR / script), *args],
        capture_output=True, text=True, env=env, timeout=300,
    )


class TestSubmitCli(unittest.TestCase):
    def test_dry_run_needs_no_credentials(self):
        result = run_script("submit_optimized.py", str(GOLDEN), "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DRY RUN", result.stdout)
        self.assertIn("validated", result.stdout)

    def test_missing_credentials_fails_before_network(self):
        result = run_script("submit_optimized.py", str(GOLDEN))
        self.assertEqual(result.returncode, 1)
        self.assertIn("PASQAL_USERNAME", result.stderr)

    def test_missing_file_fails_cleanly(self):
        result = run_script("submit_optimized.py", "no_such_pulse.toml", "--dry-run")
        self.assertNotEqual(result.returncode, 0)

    def test_corrupt_pulse_rejected_with_contract_error(self):
        import tempfile

        corrupt = GOLDEN.read_text().replace('units = "rad/us"', 'units = "MHz"')
        with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as f:
            f.write(corrupt)
        result = run_script("submit_optimized.py", f.name, "--dry-run")
        self.assertEqual(result.returncode, 1)
        self.assertIn("invalid pulse", result.stderr)


class TestTranslateCli(unittest.TestCase):
    def test_golden_passes_end_to_end(self):
        result = run_script("translate_and_simulate.py", str(GOLDEN))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS", result.stdout)


class TestConnectCli(unittest.TestCase):
    def test_missing_credentials_fails_before_network(self):
        result = run_script("../pasqal_connect.py")
        self.assertEqual(result.returncode, 1)
        self.assertIn("PASQAL_USERNAME", result.stderr)


if __name__ == "__main__":
    unittest.main()
