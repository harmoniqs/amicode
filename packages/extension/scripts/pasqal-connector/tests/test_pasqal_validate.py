"""Contract tests for pasqal_validate.py: exit codes, single-JSON-line stdout,
secret hygiene.

The pasqal_cloud SDK is fully stubbed via sys.modules injection — these tests
never touch the network and do not require pasqal-cloud to be installed. The
stub records every SDK call so tests can assert the no-job-submission
invariant, and it embeds a poison password in every exception message so
tests can prove exception text never reaches an output stream.
"""

import base64
import io
import json
import os
import subprocess
import sys
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

CONNECTOR_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(CONNECTOR_DIR))

POISON_PASSWORD = "hunter2-P0ison-pa55word"
USERNAME = "kate@example.com"
PROJECT_ID = "proj-0000-aaaa-bbbb"
CRED_ENV = {
    "PASQAL_USERNAME": USERNAME,
    "PASQAL_PASSWORD": POISON_PASSWORD,
    "PASQAL_PROJECT_ID": PROJECT_ID,
}
DEVICES = ("FRESNEL", "EMU_FREE")


class Recorder:
    """Records the name of every SDK call the script makes (never values)."""

    def __init__(self):
        self.calls = []


def build_stub(
    recorder,
    scenario="ok",
    token="tok-opaque-bearer",
    provider="full",
    provider_expires_at=None,
    devices=DEVICES,
):
    """Build stub pasqal_cloud modules mirroring pasqal-cloud 0.23's shape.

    scenario: "ok" | "auth" | "network-init" | "network-devices" | "project"
    provider: "full" (token provider reachable) | "absent" (SDK exposes no
              way to obtain the token — the session-only fallback signal)

    Every raised exception embeds POISON_PASSWORD in its message, so any
    test that finds the poison in an output stream has caught a leak.
    """
    root = types.ModuleType("pasqal_cloud")
    auth = types.ModuleType("pasqal_cloud.authentication")

    class TokenProviderError(Exception):
        pass

    auth.TokenProviderError = TokenProviderError
    root.authentication = auth

    class _TokenProvider:
        expires_at = provider_expires_at

        def get_token(self):
            recorder.calls.append("get_token")
            return token

    class _Authenticator:  # mirrors HTTPBearerAuthenticator
        def __init__(self):
            if provider == "full":
                self.token_provider = _TokenProvider()

    class _Client:
        def __init__(self):
            self.authenticator = _Authenticator()

    class _SDK:
        def __init__(self):
            self._client = _Client()

    class PasqalCloudConnection:
        def __init__(self, **kwargs):
            # Record argument NAMES only — values include the password.
            recorder.calls.append("PasqalCloudConnection(%s)" % ",".join(sorted(kwargs)))
            if scenario == "auth":
                raise TokenProviderError(
                    "login denied for password=%s" % kwargs.get("password")
                )
            if scenario == "network-init":
                raise ConnectionError(
                    "cannot reach auth endpoint; password=%s" % kwargs.get("password")
                )
            self._sdk = _SDK()

        def fetch_available_devices(self):
            recorder.calls.append("fetch_available_devices")
            if scenario == "network-devices":
                raise ConnectionError("connection dropped; secret=" + POISON_PASSWORD)
            if scenario == "project":
                raise RuntimeError(
                    "403: project not authorized; secret=" + POISON_PASSWORD
                )
            return {name: object() for name in devices}

        def submit(self, *args, **kwargs):
            recorder.calls.append("submit")

    class RemoteEmuFreeBackend:
        def __init__(self, *args, **kwargs):
            recorder.calls.append("RemoteEmuFreeBackend")

        def run(self, *args, **kwargs):
            recorder.calls.append("backend.run")

    root.PasqalCloudConnection = PasqalCloudConnection
    root.RemoteEmuFreeBackend = RemoteEmuFreeBackend
    root.SDK = _SDK
    return {"pasqal_cloud": root, "pasqal_cloud.authentication": auth}


def _purge_modules():
    for name in [
        m
        for m in list(sys.modules)
        if m == "pasqal_cloud" or m.startswith("pasqal_cloud.") or m == "pasqal_validate"
    ]:
        del sys.modules[name]


def run_validator(env, stub=None):
    """Run pasqal_validate.main() in-process with a stubbed SDK.

    Returns (exit_code, stdout, stderr).
    """
    _purge_modules()
    if stub is not None:
        sys.modules.update(stub)
    saved = {k: os.environ.pop(k) for k in list(os.environ) if k.startswith("PASQAL_")}
    os.environ.update(env)
    stdout, stderr = io.StringIO(), io.StringIO()
    code = 0
    try:
        with redirect_stdout(stdout), redirect_stderr(stderr):
            import pasqal_validate

            try:
                pasqal_validate.main()
            except SystemExit as exc:
                code = int(exc.code or 0)
    finally:
        for key in env:
            os.environ.pop(key, None)
        os.environ.update(saved)
        _purge_modules()
    return code, stdout.getvalue(), stderr.getvalue()


def make_jwt(exp_epoch):
    def b64(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=")

    return b".".join([b64({"alg": "none"}), b64({"exp": exp_epoch}), b"sig"]).decode()


class TestValidCredentials(unittest.TestCase):
    """AC1: valid credentials → exit 0 + one JSON line (project, devices, token)."""

    def test_exit_zero_and_single_json_line(self):
        recorder = Recorder()
        code, stdout, stderr = run_validator(CRED_ENV, build_stub(recorder))
        self.assertEqual(code, 0, stderr)
        self.assertEqual(stderr, "")
        lines = stdout.splitlines()
        self.assertEqual(len(lines), 1, "stdout must be exactly one JSON line")
        payload = json.loads(lines[0])
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["project_id"], PROJECT_ID)
        self.assertEqual(payload["devices"], sorted(DEVICES))
        self.assertEqual(payload["token"], "tok-opaque-bearer")
        self.assertIn("expires_at", payload)
        self.assertIsNone(payload["expires_at"])  # opaque token: no expiry known

    def test_jwt_token_reports_expiry(self):
        exp = 1900000000
        token = make_jwt(exp)
        recorder = Recorder()
        code, stdout, _ = run_validator(CRED_ENV, build_stub(recorder, token=token))
        self.assertEqual(code, 0)
        payload = json.loads(stdout)
        self.assertEqual(payload["token"], token)
        expected = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat()
        self.assertEqual(payload["expires_at"], expected)

    def test_provider_exposed_expiry_wins_over_opaque_token(self):
        expiry = datetime(2027, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        recorder = Recorder()
        code, stdout, _ = run_validator(
            CRED_ENV, build_stub(recorder, provider_expires_at=expiry)
        )
        self.assertEqual(code, 0)
        payload = json.loads(stdout)
        self.assertEqual(payload["expires_at"], expiry.isoformat())

    def test_null_token_when_sdk_cannot_yield_one(self):
        # The session-only fallback signal: still exit 0, token: null.
        recorder = Recorder()
        code, stdout, stderr = run_validator(
            CRED_ENV, build_stub(recorder, provider="absent")
        )
        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        self.assertIs(payload["ok"], True)
        self.assertIsNone(payload["token"])
        self.assertIsNone(payload["expires_at"])
        self.assertEqual(payload["devices"], sorted(DEVICES))


class TestFailureClassification(unittest.TestCase):
    """AC2: exit 2 = auth, 3 = network, 4 = project — token- and
    password-free stderr, nothing on stdout."""

    def _assert_failure(self, scenario, expected_code):
        recorder = Recorder()
        code, stdout, stderr = run_validator(CRED_ENV, build_stub(recorder, scenario=scenario))
        self.assertEqual(code, expected_code)
        self.assertEqual(stdout, "", "failures must print nothing to stdout")
        self.assertTrue(stderr.strip(), "failures must explain themselves on stderr")
        self.assertNotIn(POISON_PASSWORD, stderr)
        self.assertNotIn("tok-opaque-bearer", stderr)
        return stderr

    def test_auth_failure_exits_2(self):
        self._assert_failure("auth", 2)

    def test_network_failure_at_connect_exits_3(self):
        self._assert_failure("network-init", 3)

    def test_network_failure_at_device_fetch_exits_3(self):
        self._assert_failure("network-devices", 3)

    def test_project_authorization_failure_exits_4(self):
        self._assert_failure("project", 4)

    def test_distinct_messages_per_failure_class(self):
        messages = {
            scenario: self._assert_failure(scenario, code)
            for scenario, code in (("auth", 2), ("network-init", 3), ("project", 4))
        }
        self.assertEqual(len(set(messages.values())), 3)


if __name__ == "__main__":
    unittest.main()
