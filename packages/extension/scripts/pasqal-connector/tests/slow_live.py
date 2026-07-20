"""Optional live smoke: real Pasqal Cloud, real credentials, auth only.

Excluded from default discovery (filename does not match test_*). Run
explicitly, with pasqal-cloud installed and real credentials in env:

    PASQAL_LIVE_SMOKE=1 PASQAL_USERNAME=... PASQAL_PASSWORD=... \
    PASQAL_PROJECT_ID=... python3 -m unittest tests.slow_live -v
"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "pasqal_validate.py"


@unittest.skipUnless(
    os.environ.get("PASQAL_LIVE_SMOKE") == "1",
    "live smoke: set PASQAL_LIVE_SMOKE=1 and real PASQAL_* credentials",
)
class TestLiveValidate(unittest.TestCase):
    def test_live_auth_only_validation(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 1, "stdout must be exactly one JSON line")
        payload = json.loads(lines[0])
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["project_id"], os.environ["PASQAL_PROJECT_ID"])
        self.assertTrue(payload["devices"], "expected at least one device")
        # Never echo the token in test output on failure: assert shape only.
        self.assertIn("token", payload)
        self.assertIn("expires_at", payload)


if __name__ == "__main__":
    unittest.main()
