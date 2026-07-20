"""Contract tests for submit.py — the #160 device-path submission connector.

Runs submit.main(argv) IN-PROCESS with a fully stubbed pasqal_cloud SDK (the
sys.modules injection idiom from test_pasqal_validate.py), so nothing here
touches the network or needs pasqal-cloud installed. The real pulser IS used
(pulse_contract builds a genuine Sequence in --dry-run), which is hermetic.

Security contract under test (AC3): the runtime credential is a TOKEN reached
ONLY through the launcher's env injection (PASQAL_TOKEN + PASQAL_PROJECT_ID);
NO password/username exists anywhere in the connector, and no token value ever
reaches an output stream. Safety contract (AC5, defense in depth): a non-free
device is refused BEFORE any auth/network unless the caller passes --yes.
"""

import io
import os
import sys
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

CONNECTOR_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(CONNECTOR_DIR))
GOLDEN = Path(__file__).resolve().parent / "fixtures" / "pulse_golden.toml"

POISON_TOKEN = "tok-P0ison-do-not-print-bearer"
PROJECT_ID = "proj-0000-aaaa-bbbb"


class Recorder:
    def __init__(self):
        self.calls = []
        self.conn_kwargs = None
        self.provider_token = None
        self.backend = None


def build_stub(recorder, scenario="ok"):
    """Stub pasqal_cloud + .authentication mirroring the 0.23 shape enough for
    the connector: a TokenProvider base to subclass, a PasqalCloudConnection
    that records its kwarg NAMES (never values), and the emulator backends.
    Exceptions embed POISON_TOKEN so any leak to an output stream is caught."""
    root = types.ModuleType("pasqal_cloud")
    auth = types.ModuleType("pasqal_cloud.authentication")

    class TokenProviderError(Exception):
        pass

    class TokenProvider:  # abstract base the connector subclasses
        def __init__(self, *args, **kwargs):
            pass

        def get_token(self):
            raise NotImplementedError

    auth.TokenProviderError = TokenProviderError
    auth.TokenProvider = TokenProvider
    root.authentication = auth

    class PasqalCloudConnection:
        def __init__(self, **kwargs):
            # NAMES only — values would include the token.
            recorder.conn_kwargs = sorted(kwargs)
            recorder.calls.append("PasqalCloudConnection")
            provider = kwargs.get("token_provider")
            if provider is not None:
                recorder.provider_token = provider.get_token()
            if scenario == "auth":
                raise TokenProviderError("denied; token=" + POISON_TOKEN)

    class _Backend:
        name = "?"

        def __init__(self, sequence, connection=None, **kwargs):
            recorder.backend = type(self).__name__
            recorder.calls.append(type(self).__name__)

        def run(self, *args, **kwargs):
            recorder.calls.append("backend.run")
            if scenario == "submit-error":
                raise RuntimeError("submission blew up; token=" + POISON_TOKEN)
            return {"result": "ok"}

    class RemoteEmuFreeBackend(_Backend):
        pass

    class RemoteMPSBackend(_Backend):
        pass

    class RemoteSVBackend(_Backend):
        pass

    root.PasqalCloudConnection = PasqalCloudConnection
    root.RemoteEmuFreeBackend = RemoteEmuFreeBackend
    root.RemoteMPSBackend = RemoteMPSBackend
    root.RemoteSVBackend = RemoteSVBackend
    return {"pasqal_cloud": root, "pasqal_cloud.authentication": auth}


def _purge():
    for name in [
        m
        for m in list(sys.modules)
        if m == "pasqal_cloud" or m.startswith("pasqal_cloud.") or m == "submit"
    ]:
        del sys.modules[name]


def run_submit(argv, env=None, stub=None):
    """Run submit.main(argv) in-process; returns (code, stdout, stderr)."""
    _purge()
    if stub is not None:
        sys.modules.update(stub)
    saved = {k: os.environ.pop(k) for k in list(os.environ) if k.startswith("PASQAL_")}
    os.environ.update(env or {})
    out, err = io.StringIO(), io.StringIO()
    code = 0
    try:
        with redirect_stdout(out), redirect_stderr(err):
            import submit

            try:
                submit.main(argv)
            except SystemExit as exc:
                code = int(exc.code or 0)
    finally:
        for key in (env or {}):
            os.environ.pop(key, None)
        os.environ.update(saved)
        _purge()
    return code, out.getvalue(), err.getvalue()


class TestDryRun(unittest.TestCase):
    def test_dry_run_builds_and_validates_without_credentials(self):
        code, out, err = run_submit([str(GOLDEN), "--dry-run"])
        self.assertEqual(code, 0, err)
        self.assertIn("DRY RUN", out)
        self.assertIn("validated", out.lower())

    def test_corrupt_pulse_rejected_with_contract_error(self):
        import tempfile

        corrupt = GOLDEN.read_text().replace('units = "rad/us"', 'units = "MHz"')
        with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as f:
            f.write(corrupt)
        code, out, err = run_submit([f.name, "--dry-run"])
        self.assertEqual(code, 1)
        self.assertIn("invalid pulse", err)

    def test_missing_file_fails_cleanly(self):
        code, out, err = run_submit(["no_such_pulse.toml", "--dry-run"])
        self.assertNotEqual(code, 0)


class TestTokenBoundary(unittest.TestCase):
    """AC3: token-only via env; no password anywhere; token never printed."""

    def test_missing_token_fails_before_network(self):
        code, out, err = run_submit([str(GOLDEN)], env={"PASQAL_PROJECT_ID": PROJECT_ID})
        self.assertEqual(code, 1)
        self.assertIn("PASQAL_TOKEN", err)

    def test_no_password_or_username_anywhere_in_the_connector(self):
        # AC3: no password exists in the flow. Assert the actionable surface —
        # the connector never reads the password/username env vars and never
        # passes a password/username kwarg (the word may appear only in the
        # docstring that explains its ABSENCE, which is fine).
        code = "".join(
            line for line in (CONNECTOR_DIR / "submit.py").read_text().splitlines(keepends=True)
            if not line.lstrip().startswith("#")
        )
        self.assertNotIn("PASQAL_PASSWORD", code)
        self.assertNotIn("PASQAL_USERNAME", code)
        self.assertNotIn("password=", code)
        self.assertNotIn("username=", code)

    def test_authenticates_via_token_provider_not_password(self):
        rec = Recorder()
        env = {"PASQAL_TOKEN": "tok-live-bearer", "PASQAL_PROJECT_ID": PROJECT_ID}
        code, out, err = run_submit(
            [str(GOLDEN), "--device", "EMU_FREE"], env=env, stub=build_stub(rec)
        )
        self.assertEqual(code, 0, err)
        # connection built with token_provider + project_id ONLY — never password/username
        self.assertEqual(rec.conn_kwargs, ["project_id", "token_provider"])
        self.assertEqual(rec.provider_token, "tok-live-bearer")

    def test_token_never_reaches_an_output_stream_on_failure(self):
        rec = Recorder()
        env = {"PASQAL_TOKEN": POISON_TOKEN, "PASQAL_PROJECT_ID": PROJECT_ID}
        code, out, err = run_submit(
            [str(GOLDEN), "--device", "EMU_FREE"],
            env=env,
            stub=build_stub(rec, scenario="submit-error"),
        )
        self.assertNotEqual(code, 0)
        self.assertNotIn(POISON_TOKEN, out)
        self.assertNotIn(POISON_TOKEN, err)

    def test_auth_failure_does_not_leak_token(self):
        rec = Recorder()
        env = {"PASQAL_TOKEN": POISON_TOKEN, "PASQAL_PROJECT_ID": PROJECT_ID}
        code, out, err = run_submit(
            [str(GOLDEN), "--device", "EMU_FREE"],
            env=env,
            stub=build_stub(rec, scenario="auth"),
        )
        self.assertNotEqual(code, 0)
        self.assertNotIn(POISON_TOKEN, out)
        self.assertNotIn(POISON_TOKEN, err)


class TestDeviceSelectionAndGate(unittest.TestCase):
    """AC5 defense-in-depth + free default."""

    def test_default_device_is_the_free_emulator(self):
        rec = Recorder()
        env = {"PASQAL_TOKEN": "tok", "PASQAL_PROJECT_ID": PROJECT_ID}
        code, out, err = run_submit([str(GOLDEN)], env=env, stub=build_stub(rec))
        self.assertEqual(code, 0, err)
        self.assertEqual(rec.backend, "RemoteEmuFreeBackend")

    def test_non_free_device_refused_without_yes_before_any_auth(self):
        rec = Recorder()
        # No token supplied at all: the gate must fire BEFORE auth/network.
        code, out, err = run_submit(
            [str(GOLDEN), "--device", "EMU_MPS"], env={"PASQAL_PROJECT_ID": PROJECT_ID}, stub=build_stub(rec)
        )
        self.assertNotEqual(code, 0)
        self.assertIn("EMU_MPS", err)
        self.assertIn("--yes", err)
        # nothing was constructed or submitted
        self.assertEqual(rec.calls, [])

    def test_non_free_device_proceeds_with_yes(self):
        rec = Recorder()
        env = {"PASQAL_TOKEN": "tok", "PASQAL_PROJECT_ID": PROJECT_ID}
        code, out, err = run_submit(
            [str(GOLDEN), "--device", "EMU_MPS", "--yes"], env=env, stub=build_stub(rec)
        )
        self.assertEqual(code, 0, err)
        self.assertEqual(rec.backend, "RemoteMPSBackend")

    def test_unknown_device_rejected(self):
        rec = Recorder()
        env = {"PASQAL_TOKEN": "tok", "PASQAL_PROJECT_ID": PROJECT_ID}
        code, out, err = run_submit(
            [str(GOLDEN), "--device", "FRESNEL", "--yes"], env=env, stub=build_stub(rec)
        )
        self.assertNotEqual(code, 0)
        self.assertIn("FRESNEL", err)


if __name__ == "__main__":
    unittest.main()
