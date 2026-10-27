#!/usr/bin/env python3
"""test_deploy_gate.py — stdlib suite for deploy-gate.sh's staged boot smoke (amicode #1949, #1944).

Runs the REAL gate with AMICODE_GATE_SMOKE_ONLY=1 (only the staged smoke — no
seam suites, no engine lanes, no approval stamp) against FAKE "staged binaries":
small Python servers that answer the smoke's HTTP paths (config, session,
question, permission → 200) and stream SSE frames with `id:` lines. One fake
traps/ignores SIGTERM — the #1944 hang: the old `kill; wait` blocked forever.
The gate must now finish in ~TERM_WAIT (10s) + the smoke's own probes, and
name the failure. HOME is a temp dir, so nothing under ~/.amico is touched —
safe on the live hub.

Needs GNU `timeout` (the smoke uses it); on macOS without coreutils the smoke
cases skip. Run it on the hub from a /tmp scratch copy:
    rsync -a ops/hub/ amico-hub:/tmp/gate-test/
    ssh amico-hub 'python3 /tmp/gate-test/test_deploy_gate.py'

Run: python3 ops/hub/test_deploy_gate.py   (exit 0 on pass)
AMICODE_SHELLCHECK=<path> points the static check at a shellcheck not on PATH.
"""
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "deploy-gate.sh")
NAMED_FAILURE = "staged binary ignored SIGTERM for 10s (#1944) — killed"

# The fake staged binary: invoked as `<bin> serve --port P --hostname 127.0.0.1`.
# IGNORE_TERM is substituted per fake. It records its pid so the test can prove
# the gate left nothing running.
FAKE_SERVER = r'''#!/usr/bin/env python3
import os, signal, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
IGNORE_TERM = __IGNORE_TERM__
if IGNORE_TERM:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
args = sys.argv[1:]
port = int(args[args.index("--port") + 1])
with open(os.environ["FAKE_PIDFILE"], "w") as f:
    f.write(str(os.getpid()))
OK = {"config", "session", "question", "permission"}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.lstrip("/").split("?")[0]
        if path == "event":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                n = 0
                while n < 100:  # bounded: ~20s of heartbeats at most
                    n += 1
                    self.wfile.write(f"id: {n}\ndata: {{}}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(0.2)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        body = b"{}" if path in OK else b"no"
        self.send_response(200 if path in OK else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

srv = ThreadingHTTPServer(("127.0.0.1", port), H)
srv.daemon_threads = True
srv.serve_forever()
'''


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@unittest.skipUnless(shutil.which("timeout") and shutil.which("curl"), "the smoke needs GNU timeout + curl — run on the hub")
class SmokeShutdownTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="deploy-gate-test-")
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(os.path.join(self.home, ".amico", "server", "bin"))
        self.pidfile = os.path.join(self.tmp, "fake.pid")

    def tearDown(self):
        if os.path.exists(self.pidfile):
            with open(self.pidfile) as f:
                pid = int(f.read().strip() or 0)
            if pid and alive(pid):
                os.kill(pid, signal.SIGKILL)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake(self, ignore_term):
        p = os.path.join(self.tmp, "fake-opencode")
        with open(p, "w") as f:
            f.write(FAKE_SERVER.replace("__IGNORE_TERM__", "True" if ignore_term else "False"))
        os.chmod(p, 0o755)
        return p

    def run_gate(self, binary):
        env = dict(os.environ)
        env.update({"HOME": self.home, "AMICODE_GATE_SMOKE_ONLY": "1", "AMICODE_GATE_SMOKE_PORT": str(free_port()),
                    "FAKE_PIDFILE": self.pidfile})
        env.pop("AMICODE_GATE_SMOKE_TERM_WAIT", None)
        t0 = time.monotonic()
        r = subprocess.run(["bash", SCRIPT, "--staged-binary", binary], capture_output=True, text=True, env=env, timeout=60)
        return r.returncode, r.stdout + r.stderr, time.monotonic() - t0

    def fake_pid(self):
        with open(self.pidfile) as f:
            return int(f.read().strip())

    def approval_written(self):
        return os.path.exists(os.path.join(self.home, ".amico", "server", "bin", "opencode.GATE-APPROVED-sha"))

    def test_server_ignoring_sigterm_is_a_named_smoke_failure_not_a_hang(self):
        code, out, elapsed = self.run_gate(self.fake(ignore_term=True))
        self.assertEqual(code, 1, out)
        self.assertIn(NAMED_FAILURE, out)
        self.assertIn("FAIL  << this blocks the deploy", out)
        self.assertIn("GATE FAILED", out)
        self.assertLess(elapsed, 20, f"the gate took {elapsed:.1f}s — the bounded wait is 10s\n{out}")
        self.assertGreaterEqual(elapsed, 10, "the server got its full TERM window before KILL")
        self.assertFalse(alive(self.fake_pid()), "the TERM-ignoring server was KILLed, not left running")
        self.assertFalse(self.approval_written(), "a failed smoke records no gate approval")
        print(f"\n  TERM-ignoring fake: gate exited {code} in {elapsed:.1f}s", file=sys.stderr)

    def test_well_behaved_server_passes_promptly(self):
        code, out, elapsed = self.run_gate(self.fake(ignore_term=False))
        self.assertEqual(code, 0, out)
        self.assertIn("GATE GREEN", out)
        self.assertNotIn("ignored SIGTERM", out)
        self.assertLess(elapsed, 15, out)
        self.assertFalse(alive(self.fake_pid()))
        self.assertFalse(self.approval_written(), "a smoke-only run never records a gate approval")
        print(f"\n  well-behaved fake: gate exited {code} in {elapsed:.1f}s", file=sys.stderr)

    def test_smoke_only_without_a_staged_binary_is_a_usage_refusal(self):
        env = dict(os.environ, HOME=self.home, AMICODE_GATE_SMOKE_ONLY="1")
        r = subprocess.run(["bash", SCRIPT], capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)


class StaticChecks(unittest.TestCase):
    def test_bash_syntax(self):
        r = subprocess.run(["bash", "-n", SCRIPT], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_no_unbounded_wait_on_the_smoke_server(self):
        with open(SCRIPT) as f:
            src = f.read()
        self.assertNotIn('kill "$pid" 2>/dev/null\n    wait "$pid"', src, "the #1944 hang shape is back")
        self.assertIn("kill -KILL", src)

    @unittest.skipUnless(os.environ.get("AMICODE_SHELLCHECK") or shutil.which("shellcheck"), "shellcheck not installed")
    def test_shellcheck(self):
        sc = os.environ.get("AMICODE_SHELLCHECK") or shutil.which("shellcheck")
        r = subprocess.run([sc, SCRIPT], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
