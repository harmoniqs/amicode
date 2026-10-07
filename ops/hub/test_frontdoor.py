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
    (upstream response head + frames) once `want` appears (or timeout).
    want=None: read until the full timeout (a fixed observation window —
    used by the merged-stream test, where `want` on one shard's frame races
    the siblings' unsynchronized heartbeats)."""
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    s.settimeout(timeout)
    try:
        s.sendall((f"GET {target} HTTP/1.1\r\nHost: localhost\r\n"
                   "Accept: text/event-stream\r\n\r\n").encode())
        buf = b""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if want is not None and want in buf:
                break
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
        elif path.startswith("/assets/") and path.endswith(".js"):
            # mimic the engine/service SPA fallback: unknown hashed assets get
            # index.html (200 HTML) — the #1313 revert signature the #1723
            # guard detects and heals
            body = b"<!doctype html><html><head><title>fallback</title></head></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("X-Backend-Shard", str(self.shard))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
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

    def test_pin_count_balances_the_floor(self):
        """Pin counts join the floor: the instantaneous signals (dials,
        groups) are ~0 at admission, so without counting pinned sessions every
        placement ties to the lowest shard id — 2026-10-07 production had all
        1274 pins on shard 1 with shards 2/3 idle. A skewed premap with NO
        in-flight load must still spread new sessions to the empty shards."""
        fd = self.start_pool(premap={
            "ses_old1": 1, "ses_old2": 1, "ses_old3": 1, "ses_old4": 1,
            "ses_old5": 1, "ses_old6": 1,
        })
        # all pins on shard 1, nothing in flight -> new sessions avoid shard 1
        st, hdr, _ = http_request(fd.port, "/session/ses_bal1/message?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        self.assertIn(hdr["x-backend-shard"], ("2", "3"))
        # placement increments the pin count -> the next one rides the other
        st2, hdr2, _ = http_request(fd.port, "/session/ses_bal2/message?directory=" + POOLDIR)
        self.assertEqual(st2, 200)
        self.assertNotEqual(hdr2["x-backend-shard"], hdr["x-backend-shard"])
        # and it persists: the map carries the spread
        m = self.map_contents(fd)
        self.assertEqual(m["ses_bal1"], int(hdr["x-backend-shard"]))
        self.assertEqual(m["ses_bal2"], int(hdr2["x-backend-shard"]))

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
        """A session-scoped event stream joins the OWNING shard's single group
        (upstream head echoes the shard); the session-LESS stream is MERGED
        across the pool (slice 1c): one client stream carries heartbeats from
        every pool member -- the wire /event is directory-scoped, so the union
        is the only stream that carries off-default sessions' frames."""
        fd = self.start_pool(premap={"ses_sse": 2})
        buf = sse_read(fd.port, "/event?session=ses_sse")
        self.assertIn(b"X-Backend-Shard: 2", buf)
        self.assertIn(b"server.connected", buf)
        # merged: a fixed 3s observation window (the members' heartbeats are
        # unsynchronized) — then ALL THREE shards must be in the buffer
        gbuf = sse_read(fd.port, "/event", want=None, timeout=3)
        for n in (1, 2, 3):
            self.assertIn(('"shard":%d' % n).encode(), gbuf)
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
        # passthrough-intact = the client's EXACT target reaches the backend
        # (query included — the engine needs ?directory= to scope the request).
        # (Director adjudication 2026-10-06: the RED suite's original literal
        # omitted the query, which would require the frontdoor to STRIP it.)
        self.assertEqual(json.loads(body)["path"], "/session/ses_leg/message?directory=" + POOLDIR)
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
        # exact-target passthrough (same adjudication as the single-shard test)
        self.assertEqual(json.loads(body)["path"], "/session/ses_leg2/message?directory=/anywhere")
        self.assertFalse(os.path.exists(fd.map_path))


# --- #1717 phase 1 slice 2: the Jev placement provider through the real frontdoor --

class _SystemoneHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *args):
        pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        self.rfile.read(n)
        body = json.dumps(self.server.behavior).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def systemone_answer(shard, p):
    """A choice answer in the arjev wire shape, confident (p) on <shard>."""
    others = [s for s in (1, 2, 3) if s != shard]
    rest = round((1.0 - p) / 2, 4)
    return {"model": "jev-test", "answers": {"placement": {
        "type": "choice", "choice": str(shard), "confidence": p,
        "probabilities": {str(shard): p, str(others[0]): rest, str(others[1]): rest}}}}


class TestJevPlacement(RouterTest):

    def start_jev_frontdoor(self, answer, premap):
        httpd = _ThreadingHTTP(("127.0.0.1", 0), _SystemoneHandler)
        httpd.behavior = answer
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        receipts = os.path.join(self.tmpdir, "routing-receipts.jsonl")
        ports = {}
        for i in (1, 2, 3):
            sh = self.start_shard(i)
            ports[i] = sh.port
        with open(os.path.join(self.tmpdir, "routing-sessions.json"), "w") as f:
            json.dump(premap, f)
        fd = self.start_frontdoor(
            routing_table([(i, ports[i]) for i in (1, 2, 3)]),
            extra_env={"AMICODE_JEV_PLACEMENT": "1", "ARJEV_JEV_KEY": "test-key",
                       "AMICODE_JEV_URL": "http://127.0.0.1:%d" % httpd.server_address[1],
                       "AMICODE_ROUTING_RECEIPTS": receipts})
        return fd, receipts

    def jev_receipts(self, path):
        with open(path) as f:
            return [json.loads(x) for x in f.read().splitlines() if x.strip()]

    def test_jev_confident_overrides_floor(self):
        # floor is shard 2 (3 held sessions on shard 1 -> loads 5,0,0, tie 2/3);
        # Jev confidently says 3 -> the session lands on 3 and the receipt says jev.
        fd, receipts = self.start_jev_frontdoor(systemone_answer(3, 0.9),
                                                premap={"ses_jh1": 1, "ses_jh2": 1, "ses_jh3": 1})
        hs = [self.hold(fd, s) for s in ("ses_jh1", "ses_jh2", "ses_jh3")]
        time.sleep(0.5)
        st, hdr, _ = http_request(fd.port, "/session/ses_jev1/message?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "3")
        rows = self.jev_receipts(receipts)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["mode"], "jev")
        self.assertEqual(rows[0]["decision"], 3)
        self.assertEqual(rows[0]["session_id"], "ses_jev1")
        # sticky after the Jev placement
        st2, hdr2, _ = http_request(fd.port, "/session/ses_jev1/message")
        self.assertEqual(hdr2["x-backend-shard"], "3")
        for t in hs:
            t.join(10)

    def test_jev_low_confidence_falls_to_floor(self):
        # Jev answers below min_confidence (0.4 < 0.6) -> the deterministic floor.
        fd, receipts = self.start_jev_frontdoor(systemone_answer(3, 0.4),
                                                premap={"ses_kh1": 1, "ses_kh2": 1, "ses_kh3": 1})
        hs = [self.hold(fd, s) for s in ("ses_kh1", "ses_kh2", "ses_kh3")]
        time.sleep(0.5)
        st, hdr, _ = http_request(fd.port, "/session/ses_jev2/message?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "2")   # the floor, not Jev's 3
        rows = self.jev_receipts(receipts)
        self.assertEqual(rows[0]["mode"], "deterministic")
        self.assertEqual(rows[0]["fail_reason"], "low-confidence")
        for t in hs:
            t.join(10)


    def start_jev_local_frontdoor(self, premap=None):
        """A pool frontdoor with the LOCAL weighted allocator on and the
        sampler fast; no external systemone, so jev-local governs."""
        receipts = os.path.join(self.tmpdir, "routing-receipts.jsonl")
        fd = self.start_pool(
            premap=premap,
            extra_env={"AMICODE_JEV_LOCAL": "1", "AMICODE_SHARD_SAMPLE_INTERVAL": "0.3",
                       "AMICODE_ROUTING_RECEIPTS": receipts})
        return fd

    def test_jev_local_avoids_probe_dead_shard(self):
        # shard 2's backend is stopped -> the sampler marks it dead -> the
        # local allocator only ever offers the alive members, floor-shaped
        # ties or not.
        fd = self.start_jev_local_frontdoor()
        self.shards[1].stop()
        time.sleep(1.2)   # let the sampler record a failed probe
        seen = set()
        for i in range(8):
            st, hdr, _ = http_request(fd.port, "/session/ses_jl%d/message?directory=" % i + POOLDIR)
            self.assertEqual(st, 200)
            seen.add(int(hdr["x-backend-shard"]))
        self.assertNotIn(2, seen)
        self.assertGreaterEqual(len(seen), 1)

    def test_jev_local_spreads_equal_shards(self):
        # equal-looking members -> the weighted pick spreads a burst instead
        # of piling onto the lowest id (the 1274-pins-on-shard-1 failure).
        fd = self.start_jev_local_frontdoor()
        time.sleep(1.2)   # first sampler pass
        seen = set()
        for i in range(9):
            st, hdr, _ = http_request(fd.port, "/session/ses_jls%d/message?directory=" % i + POOLDIR)
            self.assertEqual(st, 200)
            seen.add(int(hdr["x-backend-shard"]))
        self.assertGreaterEqual(len(seen), 2)

    def test_jev_local_receipts_written(self):
        # every local decision receipts its mode, samples and scores
        fd = self.start_jev_local_frontdoor()
        time.sleep(1.2)
        st, _, _ = http_request(fd.port, "/session/ses_jlr/message?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        path = os.path.join(fd.tmpdir, "routing-receipts.jsonl")
        with open(path) as f:
            rows = [json.loads(x) for x in f.read().splitlines() if x.strip()]
        self.assertGreaterEqual(len(rows), 1)
        self.assertEqual(rows[0]["mode"], "jev-local")
        self.assertIn("scores", rows[0])
        self.assertIn("samples", rows[0])


# --- #1723: the UI-revert guard ---------------------------------------------------

class TestUIGuard(RouterTest):
    DIST_INDEX = b"<html>the current app</html>"

    def make_dist(self, built_at="2026-10-04T12:03:15.452Z", with_record=True):
        dist = os.path.join(self.tmpdir, "dist")
        os.makedirs(os.path.join(dist, "assets"), exist_ok=True)
        with open(os.path.join(dist, "index.html"), "wb") as f:
            f.write(self.DIST_INDEX)
        if with_record:
            with open(os.path.join(dist, "deploy.json"), "w") as f:
                json.dump({"commit": "8ff7606b78ebbdeca", "built_at": built_at,
                           "branch": "t", "deployed_by": "test"}, f)
        return dist, os.path.join(self.tmpdir, "ui-floor.json")

    def start_guard(self, dist, floor, min_built_at=None):
        if min_built_at is not None:
            with open(floor, "w") as f:
                json.dump({"min_built_at": min_built_at}, f)
        sh = self.start_shard(1)
        return self.start_frontdoor(
            routing_table([(1, sh.port)]),
            extra_env={"AMICODE_APP_DIST": dist, "AMICODE_UI_FLOOR": floor})

    def test_floor_ok_serves_index(self):
        dist, floor = self.make_dist()
        fd = self.start_guard(dist, floor, min_built_at="2026-10-01T00:00:00")
        st, hdr, body = http_request(fd.port, "/")
        self.assertEqual(st, 200)
        self.assertEqual(body, self.DIST_INDEX)
        self.assertEqual(hdr["x-ui-build"], "8ff7606b78eb")

    def test_floor_violation_crash_lands(self):
        dist, floor = self.make_dist(built_at="2026-10-04T12:03:15.452Z")
        fd = self.start_guard(dist, floor, min_built_at="2026-10-05T00:00:00")
        st, hdr, body = http_request(fd.port, "/")
        self.assertEqual(st, 200)
        self.assertIn(b"freshness check failed", body)
        self.assertIn(b"2026-10-05T00:00:00", body)          # the floor value is shown
        self.assertNotIn(b"the current app", body)            # never the stale bytes

    def test_missing_record_crash_lands(self):
        dist, floor = self.make_dist(with_record=False)
        fd = self.start_guard(dist, floor, min_built_at="2026-10-01T00:00:00")
        st, hdr, body = http_request(fd.port, "/")
        self.assertIn(b"freshness check failed", body)
        self.assertIn(b"MISSING deploy record", body)

    def test_no_floor_no_enforcement(self):
        dist, floor = self.make_dist()
        fd = self.start_guard(dist, floor, min_built_at=None)
        st, hdr, body = http_request(fd.port, "/")
        self.assertEqual(body, self.DIST_INDEX)

    def test_build_route(self):
        dist, floor = self.make_dist()
        fd = self.start_guard(dist, floor, min_built_at="2026-10-01T00:00:00")
        st, hdr, body = http_request(fd.port, "/__amicode_ui_build")
        self.assertEqual(st, 200)
        d = json.loads(body)
        self.assertTrue(d["floor_ok"])
        self.assertEqual(d["commit"], "8ff7606b78eb")
        self.assertEqual(d["built_at"], "2026-10-04T12:03:15.452Z")

    def test_dead_asset_heals(self):
        dist, floor = self.make_dist()
        fd = self.start_guard(dist, floor, min_built_at="2026-10-01T00:00:00")
        st, hdr, body = http_request(fd.port, "/assets/deadbeef-DEAD.js")
        self.assertEqual(st, 200)
        self.assertTrue(hdr.get("content-type", "").startswith("text/javascript"))
        self.assertIn(b"location.replace", body)               # the heal, not the broken HTML


if __name__ == "__main__":
    unittest.main(verbosity=2)
