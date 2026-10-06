#!/usr/bin/env python3
"""test_frontdoor.py — stdlib integration suite for the sharded frontdoor router.

amicode #1717 Phase 1 (branch jev-routed-pool). Spins up N fake shard backends
(http.server threads on ephemeral ports, each echoing its shard id in an
X-Backend-Shard response header) and runs the REAL frontdoor as a subprocess
with a temp routing table, temp session map, temp log, and ephemeral listen
port — no production path is ever touched, so this suite is safe to run on
the live hub itself.

Envelope note: the engine's GET /session?directory=... answers with a BARE
JSON array of Session.Info objects ({id, ..., time: {created, updated, ...}}),
sorted by time.updated desc (verified against the opencode fork's
packages/opencode/src/server/routes/instance/httpapi/groups/session.ts, whose
`list` success schema is Schema.Array(Session.Info)).

Run: python3 ops/hub/test_frontdoor.py   (exit 0 on pass)
Set AMICODE_TEST_KEEPDIR=1 to keep temp dirs for debugging.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTDOOR = os.path.join(HERE, "hub-frontdoor.py")
KEEP = bool(os.environ.get("AMICODE_TEST_KEEPDIR"))
POOLDIR = "/tmp/frontdoor-pool-dir"        # pooled across all shards
UNPOOLED = "/tmp/frontdoor-unpooled-dir"   # deliberately NOT in directory_pools


# --- helpers -------------------------------------------------------------------

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def free_port_pair():
    """The frontdoor binds P and P+1; find a free adjacent pair."""
    while True:
        p = free_port()
        s = socket.socket()
        try:
            s.bind(("0.0.0.0", p + 1))
            s.close()
            return p
        except OSError:
            s.close()


def http_request(port, target, method="GET", body=None, timeout=15):
    """One-shot raw-socket HTTP client; returns (status, headers-lower, body)."""
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        req = (f"{method} {target} HTTP/1.1\r\nHost: localhost\r\n"
               "Connection: close\r\nAccept-Encoding: identity\r\n")
        if body is not None:
            req += f"Content-Length: {len(body)}\r\nContent-Type: application/json\r\n"
        req += "\r\n"
        s.sendall(req.encode() + (body or b""))
        buf = b""
        while True:
            d = s.recv(65536)
            if not d:
                break
            buf += d
    finally:
        s.close()
    head, _, rest = buf.partition(b"\r\n\r\n")
    try:
        status = int(head.split(b" ")[1])
    except Exception:
        status = 0
    headers = {}
    for line in head.split(b"\r\n")[1:]:
        if b":" in line:
            k, v = line.split(b":", 1)
            headers[k.decode("latin1").strip().lower()] = v.decode("latin1").strip()
    return status, headers, rest


def sse_read(port, target, want=b"server.connected", timeout=12):
    """Open an SSE stream through the frontdoor; return the first bytes
    (upstream response head + frames) once `want` appears (or timeout)."""
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    s.settimeout(timeout)
    try:
        s.sendall((f"GET {target} HTTP/1.1\r\nHost: localhost\r\n"
                   "Accept: text/event-stream\r\n\r\n").encode())
        buf = b""
        deadline = time.time() + timeout
        while want not in buf and time.time() < deadline:
            d = s.recv(65536)
            if not d:
                break
            buf += d
        return buf
    finally:
        s.close()


def sess(sid, updated, directory=POOLDIR):
    """A minimal Session.Info in the REAL wire shape."""
    return {"id": sid, "slug": "sl", "directory": directory, "title": "t",
            "version": "1", "time": {"created": updated - 1, "updated": updated}}


# --- fake shard backend --------------------------------------------------------

class ShardHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    @property
    def shard(self):
        return self.server.shard_id

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-Backend-Shard", str(self.shard))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/session":
            self._json(self.server.sessions)
        elif "hold" in path:
            ms = 2000
            if "ms=" in self.path:
                try:
                    ms = int(self.path.split("ms=", 1)[1].split("&", 1)[0])
                except Exception:
                    pass
            time.sleep(ms / 1000.0)
            self._json({"held": self.path, "shard": self.shard})
        elif path == "/event" or path == "/global/event":
            self._sse()
        else:
            self._json({"shard": self.shard, "path": self.path})

    def _sse(self):
        # The response head IS the payload carrier for the shard assertion:
        # the frontdoor Group replays the upstream's raw head bytes to the
        # client, so X-Backend-Shard proves WHICH shard the group dialed.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("X-Backend-Shard", str(self.shard))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(('data: {"type":"server.connected","shard":%d}\n\n' % self.shard).encode())
            self.wfile.flush()
            while True:
                time.sleep(0.25)
                self.wfile.write(('data: {"type":"server.heartbeat","shard":%d}\n\n' % self.shard).encode())
                self.wfile.flush()
        except Exception:
            pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(n) if n else b""
        path = self.path.split("?")[0]
        if path == "/session":
            # session create: server-generated id (alnum after the ses_ prefix,
            # matching the engine's id charset)
            self.server.created += 1
            sid = "ses_srv%dx%d" % (self.shard, self.server.created)
            now = time.time()
            self._json({"id": sid, "title": "created", "directory": POOLDIR,
                        "time": {"created": now, "updated": now}}, status=201)
        else:
            self._json({"shard": self.shard, "path": self.path,
                        "echo": body.decode("utf-8", "replace")})


class _ThreadingHTTP(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class FakeShard:
    """A shard backend on an ephemeral port (or a fixed port if given)."""

    def __init__(self, shard_id, port=None, sessions=None):
        self.shard_id = shard_id
        self.port = port
        self.httpd = _ThreadingHTTP(("127.0.0.1", port or 0), ShardHandler)
        self.httpd.shard_id = shard_id
        self.httpd.sessions = sessions or []
        self.httpd.created = 0
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass


# --- frontdoor subprocess harness ----------------------------------------------

class Frontdoor:
    def __init__(self, tmpdir, table=None, extra_env=None):
        self.tmpdir = tmpdir
        self.table_path = os.path.join(tmpdir, "routing.json")
        if table is not None:
            with open(self.table_path, "w") as f:
                json.dump(table, f)
        self.map_path = os.path.join(tmpdir, "routing-sessions.json")
        self.port = free_port_pair()
        self.env = dict(os.environ)
        self.env.update({
            "AMICODE_ROUTING_TABLE": self.table_path,
            "AMICODE_SESSION_MAP": self.map_path,
            "AMICODE_FRONTDOOR_PORT": str(self.port),
            "AMICODE_FRONTDOOR_LOG": os.path.join(tmpdir, "frontdoor.log"),
        })
        self.env.update(extra_env or {})
        self.proc = None

    def start(self):
        out = open(os.path.join(self.tmpdir, "frontdoor-stdout.log"), "ab")
        self.proc = subprocess.Popen([sys.executable, FRONTDOOR], env=self.env,
                                     stdout=out, stderr=subprocess.STDOUT, cwd=HERE)
        deadline = time.time() + 10
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise AssertionError("frontdoor died at boot: rc=%s" % self.proc.poll())
            try:
                s = socket.create_connection(("127.0.0.1", self.port), timeout=0.5)
                s.close()
                return
            except OSError:
                time.sleep(0.1)
        raise AssertionError("frontdoor did not come up in 10s")

    def stop(self):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)


def routing_table(shards, pools=None, default_shard=1):
    return {
        "shards": [{"id": sid, "backend": "127.0.0.1:%d" % port} for sid, port in shards],
        "default_shard": default_shard,
        "directory_pools": pools if pools is not None else {POOLDIR: [s for s, _ in shards]},
    }


class RouterTest(unittest.TestCase):
    """Shared world-building + cleanup."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="frontdoor-test-")
        self.shards = []
        self.frontdoors = []
        self.addCleanup(self._teardown_world)

    def _teardown_world(self):
        for fd in self.frontdoors:
            fd.stop()
        for sh in self.shards:
            sh.stop()
        if KEEP:
            print("\nKEPT test dir: %s" % self.tmpdir)
        else:
            shutil.rmtree(self.tmpdir, ignore_errors=True)

    def start_shard(self, shard_id, sessions=None, port=None):
        sh = FakeShard(shard_id, port=port, sessions=sessions)
        self.shards.append(sh)
        return sh

    def start_frontdoor(self, table=None, extra_env=None):
        fd = Frontdoor(self.tmpdir, table=table, extra_env=extra_env)
        fd.start()
        self.frontdoors.append(fd)
        return fd

    def start_pool(self, premap=None, extra_env=None, sessions=None):
        """3 fake shards + a 3-shard frontdoor routing table."""
        ports = {}
        for i in (1, 2, 3):
            sh = self.start_shard(i, sessions=(sessions or {}).get(i))
            ports[i] = sh.port
        if premap:
            path = os.path.join(self.tmpdir, "routing-sessions.json")
            with open(path, "w") as f:
                json.dump(premap, f)
        fd = self.start_frontdoor(
            routing_table([(i, ports[i]) for i in (1, 2, 3)]),
            extra_env=extra_env)
        return fd

    def hold(self, fd, sid, ms=2500):
        """Fire-and-forget slow request through a STICKY (pre-mapped) session —
        holds one in-flight upstream dial on that session's shard."""
        t = threading.Thread(
            target=lambda: http_request(fd.port, "/session/%s/hold?ms=%d" % (sid, ms), timeout=10),
            daemon=True)
        t.start()
        return t

    def map_contents(self, fd):
        try:
            with open(fd.map_path) as f:
                return json.load(f)
        except Exception:
            return None


# --- the 8 brief criteria (+ ceiling & create-sniff) ----------------------------

class TestShardedRouter(RouterTest):

    def test_sticky_placement_persistence(self):
        """Sticky: two requests for one new session hit the same shard; the map
        records it; a frontdoor restart keeps the session on the same shard."""
        fd = self.start_pool()
        st, hdr, _ = http_request(fd.port, "/session/ses_sticky1/message?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        first_shard = hdr["x-backend-shard"]
        st2, hdr2, _ = http_request(fd.port, "/session/ses_sticky1/message")
        self.assertEqual(st2, 200)
        self.assertEqual(hdr2["x-backend-shard"], first_shard)
        self.assertEqual(self.map_contents(fd)["ses_sticky1"], int(first_shard))
        # persistence: kill + restart the frontdoor subprocess (same map file)
        fd.stop()
        fd.start()
        st3, hdr3, _ = http_request(fd.port, "/session/ses_sticky1/message")
        self.assertEqual(st3, 200)
        self.assertEqual(hdr3["x-backend-shard"], first_shard)

    def test_placement_least_loaded_and_ties(self):
        """Placement: skewed load (in-flight upstream requests) sends new
        sessions to the least-loaded pool member; ties break to lowest id.
        Holds dominate the default shard's baseline SSE-group noise."""
        fd = self.start_pool(premap={
            "ses_h1a": 1, "ses_h1b": 1, "ses_h1c": 1, "ses_h1d": 1,
            "ses_h2a": 2, "ses_h2b": 2, "ses_h2c": 2,
            "ses_h3a": 3, "ses_h3b": 3, "ses_h3c": 3,
        })
        # least-loaded: 3 held on shard 1, 3 on shard 2 -> new lands on 3
        hs = [self.hold(fd, s) for s in ("ses_h1a", "ses_h1b", "ses_h1c",
                                         "ses_h2a", "ses_h2b", "ses_h2c")]
        time.sleep(0.5)
        st, hdr, _ = http_request(fd.port, "/session/ses_plc1/message?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "3")
        for t in hs:
            t.join(10)
        # least-loaded: 4 held on shard 1, 2 on shard 3 -> new lands on 2
        hs = [self.hold(fd, s) for s in ("ses_h1a", "ses_h1b", "ses_h1c", "ses_h1d",
                                         "ses_h3a", "ses_h3b")]
        time.sleep(0.5)
        st, hdr, _ = http_request(fd.port, "/session/ses_plc2/message?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "2")
        for t in hs:
            t.join(10)
        # tie between shards 2 and 3 (shard 1 pushed out of the tie) -> lowest id wins
        hs = [self.hold(fd, s) for s in ("ses_h1a", "ses_h1b", "ses_h1c",
                                         "ses_h2a", "ses_h3a")]
        time.sleep(0.5)
        st, hdr, _ = http_request(fd.port, "/session/ses_plc3/message?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "2")
        for t in hs:
            t.join(10)

    def test_fanout_merge(self):
        """GET /session?directory=<pooled dir> merges every pool member's list:
        exact envelope (bare array), dedupe by id, order time_updated desc."""
        fd = self.start_pool(sessions={
            1: [sess("ses_l1", 100), sess("ses_l2", 300)],
            2: [sess("ses_l3", 200)],
            3: [sess("ses_l4", 400), sess("ses_l1", 100)],  # ses_l1 dup (defensive)
        })
        st, hdr, body = http_request(fd.port, "/session?directory=" + POOLDIR + "&limit=50")
        self.assertEqual(st, 200)
        self.assertTrue(hdr.get("content-type", "").startswith("application/json"))
        data = json.loads(body)
        self.assertIsInstance(data, list, "merged response must be the bare-array envelope")
        ids = [s["id"] for s in data]
        self.assertEqual(ids, ["ses_l4", "ses_l2", "ses_l3", "ses_l1"])
        for s in data:
            self.assertIn("time", s)
            self.assertIn("updated", s["time"])

    def test_directory_default_routes_to_default_shard(self):
        """An unknown session requesting a NON-pooled ?directory= gets
        default_shard (no placement, no session-map pinning)."""
        fd = self.start_pool()
        st, hdr, _ = http_request(fd.port, "/session/ses_dirdef/message?directory=" + UNPOOLED)
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "1")
        self.assertNotIn("ses_dirdef", self.map_contents(fd) or {})

    def test_global_routes_to_default_shard(self):
        """No-session global routes (no session id anywhere in the target)
        route to default_shard."""
        fd = self.start_pool()
        for target in ("/global/health", "/provider", "/config/providers"):
            st, hdr, _ = http_request(fd.port, target)
            self.assertEqual(st, 200, target)
            self.assertEqual(hdr["x-backend-shard"], "1", target)

    def test_sse_routes_to_owning_shard(self):
        """A session-scoped event stream joins the OWNING shard's group; a
        global stream joins the default shard's group. The upstream head
        (with its X-Backend-Shard echo) is what the client receives first."""
        fd = self.start_pool(premap={"ses_sse": 2})
        buf = sse_read(fd.port, "/event?session=ses_sse")
        self.assertIn(b"X-Backend-Shard: 2", buf)
        self.assertIn(b"server.connected", buf)
        gbuf = sse_read(fd.port, "/event")
        self.assertIn(b"X-Backend-Shard: 1", gbuf)
        self.assertIn(b"server.connected", gbuf)

    def test_dead_backend_blast_radius(self):
        """With one shard's backend down, ITS requests 503 fast; sessions on
        other shards keep serving."""
        fd = self.start_pool(premap={"ses_dead": 2, "ses_alive": 3})
        fd.shards = None  # unused; keep linters quiet
        self.shards[1].stop()  # shard 2's backend goes down
        t0 = time.time()
        st, hdr, _ = http_request(fd.port, "/session/ses_dead/message", timeout=10)
        elapsed = time.time() - t0
        self.assertEqual(st, 503)
        self.assertEqual(hdr.get("retry-after"), "2")
        self.assertLess(elapsed, 3.0, "503 must be fast, not a queued retry")
        st2, hdr2, _ = http_request(fd.port, "/session/ses_alive/message")
        self.assertEqual(st2, 200)
        self.assertEqual(hdr2["x-backend-shard"], "3")

    def test_dial_ceiling_sheds(self):
        """AMICODE_MAX_DIALS: at the in-flight dial ceiling, new requests get
        an immediate 503 instead of piling on."""
        fd = self.start_pool(premap={"ses_hold": 1}, extra_env={"AMICODE_MAX_DIALS": "1"})
        result = {}

        def hold_once():
            result["hold"] = http_request(fd.port, "/session/ses_hold/hold?ms=2000", timeout=10)
        t = threading.Thread(target=hold_once, daemon=True)
        t.start()
        time.sleep(0.5)
        st, hdr, _ = http_request(fd.port, "/session/ses_other/message", timeout=10)
        self.assertEqual(st, 503)
        self.assertEqual(hdr.get("retry-after"), "2")
        t.join(10)
        self.assertEqual(result["hold"][0], 200, "the one in-flight dial must still complete")

    def test_create_post_sniff_pins_new_session(self):
        """POST /session (server-generated id) places on the directory's pool
        and the created id is pinned to that shard (response sniff)."""
        fd = self.start_pool(premap={"ses_h1a": 1, "ses_h1b": 1, "ses_h1c": 1})
        hs = [self.hold(fd, s) for s in ("ses_h1a", "ses_h1b", "ses_h1c")]
        time.sleep(0.5)
        st, hdr, body = http_request(fd.port, "/session?directory=" + POOLDIR,
                                     method="POST", body=b"{}")
        self.assertEqual(st, 201)
        self.assertEqual(hdr["x-backend-shard"], "2")  # least-loaded (shard 1 held)
        created = json.loads(body)["id"]
        self.assertTrue(created.startswith("ses_"))
        # follow-up request (NO directory) must stick to the creating shard
        st2, hdr2, _ = http_request(fd.port, "/session/%s/message" % created)
        self.assertEqual(st2, 200)
        self.assertEqual(hdr2["x-backend-shard"], "2")
        self.assertEqual(self.map_contents(fd).get(created), 2)
        for t in hs:
            t.join(10)


class TestLegacyRegression(RouterTest):

    def test_single_shard_table_is_legacy(self):
        """A single-shard table = legacy single-backend behavior: every request
        proxies to the one backend, responses passthrough intact, and the
        session map is never written."""
        sh = self.start_shard(1)
        fd = self.start_frontdoor(routing_table([(1, sh.port)], pools={POOLDIR: [1]}))
        st, hdr, body = http_request(fd.port, "/session/ses_leg/message?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "1")
        self.assertEqual(json.loads(body)["path"], "/session/ses_leg/message")
        st2, hdr2, body2 = http_request(fd.port, "/session", method="POST",
                                        body=b'{"hello":"world"}')
        self.assertEqual(st2, 201)
        self.assertEqual(hdr2["x-backend-shard"], "1")
        self.assertTrue(json.loads(body2)["id"].startswith("ses_"))
        self.assertFalse(os.path.exists(fd.map_path), "legacy mode must never write the session map")

    def test_no_table_file_is_legacy_default_backend(self):
        """NO table file: everything proxies to the default backend
        (127.0.0.1:4095), exactly as today. Skipped where 4095 is occupied
        (i.e. on the live hub, where binding it would fight production)."""
        probe = socket.socket()
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", 4095))
        except OSError:
            probe.close()
            self.skipTest("127.0.0.1:4095 occupied (live hub) — cannot exercise the no-table default")
        probe.close()
        self.start_shard(1, port=4095)
        fd = self.start_frontdoor(table=None)
        st, hdr, body = http_request(fd.port, "/session/ses_leg2/message?directory=/anywhere")
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "1")
        self.assertEqual(json.loads(body)["path"], "/session/ses_leg2/message")
        self.assertFalse(os.path.exists(fd.map_path))


if __name__ == "__main__":
    unittest.main(verbosity=2)
