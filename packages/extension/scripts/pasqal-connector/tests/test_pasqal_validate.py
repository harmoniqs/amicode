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
    token_cache_expiry=None,
    devices=DEVICES,
):
    """Build stub pasqal_cloud modules mirroring pasqal-cloud 0.23.0's real
    shape: PasqalCloudConnection.cloud_client (PasqalCloudClient) ._client
    (HTTPClient) .authenticator (HTTPBearerAuthenticator) .token_provider
    (ExpiringTokenProvider, caching (expiry, token) in __token_cache).

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

    class _TokenProvider:  # mirrors ExpiringTokenProvider
        def get_token(self):
            recorder.calls.append("get_token")
            return token

    if token_cache_expiry is not None:
        setattr(
            _TokenProvider,
            "_ExpiringTokenProvider__token_cache",
            (token_cache_expiry, token),
        )

    class _Authenticator:  # mirrors HTTPBearerAuthenticator
        def __init__(self):
            if provider == "full":
                self.token_provider = _TokenProvider()

    class _HTTPClient:
        def __init__(self):
            self.authenticator = _Authenticator() if provider == "full" else None

    class _PasqalCloudClient:
        def __init__(self):
            self._client = _HTTPClient()

        def get_device_specs_dict(self):
            recorder.calls.append("get_device_specs_dict")
            if scenario == "network-devices":
                raise ConnectionError("connection dropped; secret=" + POISON_PASSWORD)
            if scenario == "project":
                raise RuntimeError(
                    "403: project not authorized; secret=" + POISON_PASSWORD
                )
            return {name: "<device-spec-json>" for name in devices}

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
            self.cloud_client = _PasqalCloudClient()

        def fetch_available_devices(self):
            # The real method deserializes device specs via pulser; the
            # validator should stay on the plain specs-dict path instead.
            recorder.calls.append("fetch_available_devices")
            return {
                name: object() for name in self.cloud_client.get_device_specs_dict()
            }

        def submit(self, *args, **kwargs):
            recorder.calls.append("submit")

    class RemoteEmuFreeBackend:
        def __init__(self, *args, **kwargs):
            recorder.calls.append("RemoteEmuFreeBackend")

        def run(self, *args, **kwargs):
            recorder.calls.append("backend.run")

    root.PasqalCloudConnection = PasqalCloudConnection
    root.RemoteEmuFreeBackend = RemoteEmuFreeBackend
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

    def test_provider_token_cache_expiry_wins_over_opaque_token(self):
        # pasqal-cloud's ExpiringTokenProvider caches (expiry, token); the
        # cached expiry is exact even when the token is not a decodable JWT.
        expiry = datetime(2027, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        recorder = Recorder()
        code, stdout, _ = run_validator(
            CRED_ENV, build_stub(recorder, token_cache_expiry=expiry)
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


class TestNoSubmissionPath(unittest.TestCase):
    """AC3: auth only — the stub records every call; no run/submit/job path."""

    FORBIDDEN = ("run", "submit", "batch", "backend", "job", "sequence")

    def test_no_run_or_submit_invoked(self):
        recorder = Recorder()
        code, _, _ = run_validator(CRED_ENV, build_stub(recorder))
        self.assertEqual(code, 0)
        # Positive control: the calls we DO expect were recorded.
        self.assertIn("PasqalCloudConnection(password,project_id,username)", recorder.calls)
        self.assertIn("get_device_specs_dict", recorder.calls)
        self.assertIn("get_token", recorder.calls)
        # Device names must come from the plain specs dict, not from
        # fetch_available_devices (which deserializes specs via pulser).
        self.assertNotIn("fetch_available_devices", recorder.calls)
        for call in recorder.calls:
            for forbidden in self.FORBIDDEN:
                self.assertNotIn(
                    forbidden, call.lower(),
                    f"job-submission call path invoked: {call}",
                )

    def test_no_submission_attempted_even_on_project_failure(self):
        recorder = Recorder()
        run_validator(CRED_ENV, build_stub(recorder, scenario="project"))
        joined = " ".join(recorder.calls).lower()
        for forbidden in self.FORBIDDEN:
            self.assertNotIn(forbidden, joined)


class TestSecretHygiene(unittest.TestCase):
    """AC4: the password appears in no argv and no output stream."""

    SCENARIOS = ("ok", "auth", "network-init", "network-devices", "project")

    def test_password_never_in_output_streams(self):
        for scenario in self.SCENARIOS:
            with self.subTest(scenario=scenario):
                recorder = Recorder()
                _, stdout, stderr = run_validator(
                    CRED_ENV, build_stub(recorder, scenario=scenario)
                )
                self.assertNotIn(POISON_PASSWORD, stdout)
                self.assertNotIn(POISON_PASSWORD, stderr)

    def test_password_never_in_argv(self):
        # The script takes credentials from env ONLY: its invocation argv is
        # just [interpreter, script]. Prove the in-process run never saw the
        # password in argv, and that a real spawn (against an on-disk poison
        # stub — never the live service) needs no secret arguments and leaks
        # nothing on either stream.
        recorder = Recorder()
        run_validator(CRED_ENV, build_stub(recorder))
        self.assertNotIn(POISON_PASSWORD, " ".join(sys.argv))
        argv = [sys.executable, str(CONNECTOR_DIR / "pasqal_validate.py")]
        self.assertNotIn(POISON_PASSWORD, " ".join(argv))
        with _spawn_stub(SPAWN_STUB_AUTH_FAIL) as stub_path:
            result = _spawn_validator(argv, env_extra=CRED_ENV, pythonpath=stub_path)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertNotIn(POISON_PASSWORD, result.stdout + result.stderr)

    def test_missing_env_fails_cleanly_before_sdk_import(self):
        # Spawned with no PASQAL_* vars: the env guard must fire (exit 1,
        # names the variable) before any SDK import is attempted — the stub
        # here would explode the run if it were imported.
        argv = [sys.executable, str(CONNECTOR_DIR / "pasqal_validate.py")]
        with _spawn_stub(SPAWN_STUB_IMPORT_BOMB) as stub_path:
            result = _spawn_validator(argv, env_extra={}, pythonpath=stub_path)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("PASQAL_USERNAME", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_missing_sdk_renders_distinctly_not_as_traceback(self):
        # Misconfigured python (no pasqal-cloud) must render as its own fixed
        # error — never an uncaught traceback, never a network/auth code.
        argv = [sys.executable, str(CONNECTOR_DIR / "pasqal_validate.py")]
        with _spawn_stub(SPAWN_STUB_IMPORT_BOMB) as stub_path:
            result = _spawn_validator(argv, env_extra=CRED_ENV, pythonpath=stub_path)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("pasqal-cloud", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn(POISON_PASSWORD, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_missing_password_named_specifically(self):
        argv = [sys.executable, str(CONNECTOR_DIR / "pasqal_validate.py")]
        with _spawn_stub(SPAWN_STUB_IMPORT_BOMB) as stub_path:
            result = _spawn_validator(
                argv,
                env_extra={"PASQAL_USERNAME": USERNAME, "PASQAL_PROJECT_ID": PROJECT_ID},
                pythonpath=stub_path,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn("PASQAL_PASSWORD", result.stderr)


# On-disk stubs for subprocess runs: a pasqal_cloud package on PYTHONPATH
# shadows any locally installed SDK, so spawn tests stay hermetic (no
# network) even on machines where pasqal-cloud is really installed.
SPAWN_STUB_AUTH_FAIL = {
    "__init__.py": (
        "from pasqal_cloud.authentication import TokenProviderError\n"
        "\n"
        "class PasqalCloudConnection:\n"
        "    def __init__(self, **kwargs):\n"
        "        raise TokenProviderError(\n"
        "            'denied; password=%s' % kwargs.get('password'))\n"
    ),
    "authentication.py": "class TokenProviderError(Exception):\n    pass\n",
}
SPAWN_STUB_IMPORT_BOMB = {
    "__init__.py": "raise ImportError('pasqal-cloud not installed (simulated)')\n",
}


class _spawn_stub:
    def __init__(self, files):
        self.files = files

    def __enter__(self):
        import tempfile

        self.tmpdir = tempfile.TemporaryDirectory()
        pkg = Path(self.tmpdir.name) / "pasqal_cloud"
        pkg.mkdir()
        for name, body in self.files.items():
            (pkg / name).write_text(body)
        return self.tmpdir.name

    def __exit__(self, *exc_info):
        self.tmpdir.cleanup()
        return False


def _spawn_validator(argv, env_extra, pythonpath):
    env = {k: v for k, v in os.environ.items() if not k.startswith("PASQAL_")}
    env["PYTHONPATH"] = pythonpath
    env.update(env_extra)
    return subprocess.run(argv, capture_output=True, text=True, env=env, timeout=60)


if __name__ == "__main__":
    unittest.main()
