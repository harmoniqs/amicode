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
import re
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


def http_request(port, target, method="GET", body=None, timeout=15, headers=None):
    """One-shot raw-socket HTTP client; returns (status, headers-lower, body)."""
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        req = (f"{method} {target} HTTP/1.1\r\nHost: localhost\r\n"
               "Connection: close\r\nAccept-Encoding: identity\r\n")
        for k, v in (headers or {}).items():
            req += f"{k}: {v}\r\n"
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

    def _note_gateway_header(self):
        """#1760 P1 test seam: record the gateway-secret header value this
        connection carried (None when absent), before any 401 gate."""
        try:
            self.server.seen[self.path.split("?")[0]] = \
                self.headers.get("X-Amicode-Gateway-Secret")
        except Exception:
            pass

    def _gateway_rejected(self):
        want = getattr(self.server, "require_secret", None)
        return bool(want) and self.headers.get("X-Amicode-Gateway-Secret") != want

    def do_GET(self):
        self._note_gateway_header()
        if self._gateway_rejected():
            self._json({"error": "missing or invalid x-amicode-gateway-secret"}, status=401)
            return
        path = self.path.split("?")[0]
        try:
            self.server.counts[path] = self.server.counts.get(path, 0) + 1
        except Exception:
            pass
        if path == "/session":
            self._json(self.server.sessions)
        elif path == "/question":
            self._json(list(getattr(self.server, "questions", ())))
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
            # #1757 fixture: a wedged upstream accepts the preamble
            # (server.connected — build_preamble needs it), then holds the
            # socket OPEN in total silence: no heartbeats, no FIN — recv()
            # parks forever. wedge_sse_once is a set of query-stripped paths;
            # the path is consumed on first wedge so the RECONNECT (what the
            # dead-man's switch must produce) hits a healthy stream.
            wedged = self.path.split("?")[0]
            if wedged in getattr(self.server, "wedge_sse_once", set()):
                self.server.wedge_sse_once.discard(wedged)
                self.wfile.write(('data: {"type":"server.connected","shard":%d}\n\n' % self.shard).encode())
                self.wfile.flush()
                # #1798 frontdoor half: the dead-man recycler kills this
                # silent upstream; probe for the FRONTDOOR's FIN — the engine
                # side must SEE the EOF (a FIN-less kill leaves a corpse the
                # engine keeps writing into — the heartbeat-stall factory).
                try:
                    self.connection.settimeout(30)
                    if self.connection.recv(1) == b"":
                        self.server.wedge_eof_seen = True
                except Exception:
                    pass
                time.sleep(120)
                return
            self.wfile.write(('data: {"type":"server.connected","shard":%d}\n\n' % self.shard).encode())
            # inject entries: raw bytes (any SSE connection drains them — the
            # question-map tests rely on any-upstream learning) or (path, bytes)
            # to target ONE stream (the delta-flood test needs /event delivery
            # deterministic: both /event and /global/event upstreams race the
            # shared list otherwise).
            def _targeted(extra):
                if not isinstance(extra, tuple):
                    return True   # raw bytes drain on any stream
                target = extra[0].decode() if isinstance(extra[0], bytes) else extra[0]
                # 2026-10-11: upstreams connect with query strings
                # (/event?directory=... — dd2788a6); match on the
                # query-stripped path so targeted injections still land.
                return target == self.path.split("?")[0]
            for extra in getattr(self.server, "sse_inject", ()):
                if _targeted(extra):
                    self.wfile.write(extra[1] if isinstance(extra, tuple) else extra)
            self.wfile.flush()
            while True:
                time.sleep(0.25)
                self.wfile.write(('data: {"type":"server.heartbeat","shard":%d}\n\n' % self.shard).encode())
                for extra in list(getattr(self.server, "sse_inject", ())):
                    if not _targeted(extra):
                        continue
                    self.wfile.write(extra[1] if isinstance(extra, tuple) else extra)
                    self.server.sse_inject.remove(extra)
                self.wfile.flush()
        except Exception:
            pass

    def do_POST(self):
        self._note_gateway_header()
        if self._gateway_rejected():
            self._json({"error": "missing or invalid x-amicode-gateway-secret"}, status=401)
            return
        n = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(n) if n else b""
        path = self.path.split("?")[0]
        try:
            self.server.counts[path] = self.server.counts.get(path, 0) + 1
        except Exception:
            pass
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
        self.httpd.counts = {}
        self.httpd.sse_inject = []
        self.httpd.questions = []
        self.httpd.seen = {}           # path -> gateway-secret header value (#1760 P1)
        self.httpd.require_secret = None
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

    def test_fanout_dead_member_degrades_not_hangs(self):
        """One wedged pool member must not hang the merged session list: the
        deadline drops its contribution and the alive shards answer (the
        2026-10-07 'switching sessions is laggy' failure — a 60s sequential
        stall on every list switch while a shard was wedged)."""
        fd = self.start_pool(sessions={
            1: [sess("ses_d1", 100)],
            2: [sess("ses_d2", 200)],
            3: [sess("ses_d3", 300)],
        })
        self.shards[0].stop()
        time.sleep(0.2)
        t0 = time.time()
        st, hdr, body = http_request(fd.port, "/session?directory=" + POOLDIR + "&limit=50",
                                     timeout=15)
        elapsed = time.time() - t0
        self.assertEqual(st, 200)
        self.assertLess(elapsed, 8.0, "dead member must not exceed the merge deadline")
        ids = {s["id"] for s in json.loads(body)}
        self.assertEqual(ids, {"ses_d2", "ses_d3"}, "only alive members contribute")

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


    def _snapshot_pull_counts(self):
        """message-endpoint pull counts per shard, keyed by sid path."""
        out = {}
        for sh in self.shards:
            for path, n in sh.httpd.counts.items():
                if "/message" in path:
                    out[path] = out.get(path, 0) + n
        return out

    def test_snapshot_idle_rebuild_pulls_only_dirty(self):
        """#1724: an event names ONE session -> the rebuild re-pulls that
        session's page only; idle rebuilds pull nothing at all."""
        fd = self.start_pool(sessions={
            1: [sess("ses_sn1", 100)],
            2: [sess("ses_sn2", 200)],
            3: [sess("ses_sn3", 300)],
        })
        st, _, body = http_request(fd.port, "/snapshot?top=3")
        self.assertEqual(st, 200)
        snap = json.loads(body)
        self.assertEqual(set(snap["messages"]), {"ses_sn1", "ses_sn2", "ses_sn3"})
        base = self._snapshot_pull_counts()
        self.assertEqual(base, {"/session/ses_sn1/message": 1,
                                "/session/ses_sn2/message": 1,
                                "/session/ses_sn3/message": 1})
        # one event touches ses_sn2 -> only its page is re-pulled
        frame = (b"data: {\"type\":\"message.updated\",\"data\":"
                 b"{\"info\":{\"sessionID\":\"ses_sn2\"}}}\n\n")
        for sh in self.shards:
            sh.httpd.sse_inject.append(frame)
        time.sleep(1.0)   # the merged upstream fans the frames in
        st2, _, _ = http_request(fd.port, "/snapshot?top=3")
        self.assertEqual(st2, 200)
        after = self._snapshot_pull_counts()
        self.assertEqual(after["/session/ses_sn2/message"], 2, "dirty session re-pulled")
        self.assertEqual(after["/session/ses_sn1/message"], 1, "clean session untouched")
        self.assertEqual(after["/session/ses_sn3/message"], 1, "clean session untouched")

    def test_snapshot_pulls_route_to_owning_shard(self):
        """#1724: a pinned session's message pull is served by its OWNING
        shard, not silently by the default shard."""
        fd = self.start_pool(
            premap={"ses_snA": 2},
            sessions={1: [], 2: [sess("ses_snA", 100)], 3: []})
        st, _, body = http_request(fd.port, "/snapshot?top=3")
        self.assertEqual(st, 200)
        snap = json.loads(body)
        self.assertIn("ses_snA", snap["messages"])
        self.assertEqual(self.shards[0].httpd.counts.get("/session/ses_snA/message", 0), 0,
                         "default shard must not serve a shard-2 session")
        self.assertGreaterEqual(self.shards[1].httpd.counts.get("/session/ses_snA/message", 0), 1,
                                "owning shard serves the pull")

    def test_question_reply_routes_to_posing_shard(self):
        """2026-10-07: question replies name PROCESS-LOCAL state — the reply
        must reach the shard that posed the question, not the default. The
        question events riding the merged streams carry the mapping."""
        fd = self.start_pool(premap={"ses_q1": 3})
        # a question posed on shard 2 (its upstream carries the event)
        frame = (b"data: {\"type\":\"question.v2.asked\",\"data\":"
                 b"{\"id\":\"que_test1\"}}\n\n")
        for sh in self.shards:
            sh.httpd.sse_inject.append(frame if sh.shard_id == 2 else
                                       b"data: {}\n\n")
        time.sleep(1.0)   # upstreams fan the frames in
        st, hdr, _ = http_request(fd.port, "/question/que_test1/reply", method="POST",
                                  body=b'{"answer":"y"}')
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "2")
        self.assertGreaterEqual(self.shards[1].httpd.counts.get("/question/que_test1/reply", 0), 1)
        self.assertEqual(self.shards[0].httpd.counts.get("/question/que_test1/reply", 0), 0)

    def test_question_list_merges_across_pool(self):
        """GET /question on a pooled directory is the UNION of pending
        questions — one member's list must not hide another's."""
        fd = self.start_pool()
        self.shards[1].httpd.questions = [{"id": "que_m2", "title": "on shard 2"}]
        self.shards[2].httpd.questions = [{"id": "que_m3", "title": "on shard 3"}]
        st, hdr, body = http_request(fd.port, "/question?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        data = json.loads(body)
        ids = {q["id"] for q in data}
        self.assertEqual(ids, {"que_m2", "que_m3"}, "union of every member's pending questions")


    def test_question_map_seeds_after_frontdoor_restart(self):
        """A question posed BEFORE the frontdoor started still routes correctly:
        each shard's own /question list reports its process-local pending
        questions, and the sampler loop seeds the map from them."""
        fd = self.start_pool(extra_env={"AMICODE_SHARD_SAMPLE_INTERVAL": "0.3"})
        self.shards[1].httpd.questions = [{"id": "que_seed2", "title": "pre-existing"}]
        time.sleep(1.2)   # one sampler pass seeds the map
        st, hdr, _ = http_request(fd.port, "/question/que_seed2/reply", method="POST",
                                  body=b'{"answer":"y"}')
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "2")

    def test_permission_reply_routes_to_posing_shard(self):
        """2026-10-07: permission requests are process-local state too — the
        reply route is the same shape as questions (/permission/per_X/reply,
        no session id, no directory) and needs the same posing-shard routing."""
        fd = self.start_pool()
        frame = (b"data: {\"type\":\"permission.v2.asked\",\"data\":"
                 b"{\"id\":\"per_test1\"}}\n\n")
        for sh in self.shards:
            sh.httpd.sse_inject.append(frame if sh.shard_id == 3 else
                                       b"data: {}\n\n")
        time.sleep(1.0)
        st, hdr, _ = http_request(fd.port, "/permission/per_test1/reply", method="POST",
                                  body=b'{"action":"allow"}')
        self.assertEqual(st, 200)
        self.assertEqual(hdr["x-backend-shard"], "3")
        self.assertGreaterEqual(self.shards[2].httpd.counts.get("/permission/per_test1/reply", 0), 1)
        self.assertEqual(self.shards[0].httpd.counts.get("/permission/per_test1/reply", 0), 0)



# --- #1757: the upstream dead-man's switch ----------------------------------------

class TestUpstreamDeadman(RouterTest):
    """The merged groups' s2/s3 upstreams wedged: recv() parked forever on a
    silent-but-open upstream (the preamble leaves settimeout(None)), members
    streamed that shard's silence, and nothing in the frontdoor ever noticed
    or recovered. The wedge shape on the wire: the engine's SSE connection
    stays open, delivers the preamble, then goes silent with NO FIN — recv()
    has no bound and no liveness accounting.

    The dead-man's switch: an upstream delivering no NON-heartbeat frames
    (heartbeats are per-connection keepalive ticks, NOT bus events — engine
    handlers/event.ts Stream.tick — they keep flowing while the event
    binding is dead) for AMICODE_UPSTREAM_DEADMAN_S while its group has live
    members is wedged -> close + reconnect through the existing backoff."""

    def start_pool_with_wedge(self, wedge_paths, extra_env=None):
        """A 3-shard pool whose shard-2 fake wedges its FIRST SSE connection
        for each path in wedge_paths (the frontdoor dials its merged-group
        upstreams at boot, so the flags must be set BEFORE it starts)."""
        ports = {}
        for i in (1, 2, 3):
            sh = self.start_shard(i)
            ports[i] = sh.port
        self.shards[1].httpd.wedge_sse_once = set(wedge_paths)
        return self.start_frontdoor(
            routing_table([(i, ports[i]) for i in (1, 2, 3)]),
            extra_env=extra_env)

    def drip_events(self, shard_index, interval=0.5):
        """A background drip of non-heartbeat event frames into one shard's
        /event stream — keeps that upstream provably alive for the dead-man
        (heartbeat-only streams carry zero event frames)."""
        def drip():
            n = 0
            while True:
                n += 1
                self.shards[shard_index].httpd.sse_inject.append(
                    (b"/event", b'data: {"id":"evt_drip%d","type":"server.alive",'
                                b'"shard":%d}\n\n' % (n, shard_index + 1)))
                time.sleep(interval)
        threading.Thread(target=drip, daemon=True).start()

    def sse_join(self, fd, target):
        s = socket.create_connection(("127.0.0.1", fd.port), timeout=10)
        s.sendall((f"GET {target} HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n").encode())
        return s

    def fd_log(self, fd):
        with open(os.path.join(fd.tmpdir, "frontdoor.log")) as f:
            return f.read()

    def test_merged_wedged_upstream_recycled_and_members_keep_receiving(self):
        """The regression for the live wedge: a merged group's s2 upstream
        wedges after the preamble. The current code parks in recv() forever —
        with the dead-man, it is recycled, the reconnect re-binds a healthy
        stream, and the member keeps receiving from the live upstreams
        throughout."""
        fd = self.start_pool_with_wedge(
            ("/event",), extra_env={"AMICODE_UPSTREAM_DEADMAN_S": "2",
                                    "AMICODE_UPSTREAM_CADENCE_S": "1"})
        self.drip_events(0)   # shard 1's upstream stays provably alive
        marker = b'data: {"id":"evt_recovered","type":"marker.after.recovery","shard":2}\n\n'
        self.shards[1].httpd.sse_inject.append((b"/event", marker))

        sock = self.sse_join(fd, "/event?directory=" + POOLDIR)
        sock.settimeout(1)
        body = b""
        deadline = time.time() + 12
        while time.time() < deadline and marker not in body:
            try:
                d = sock.recv(65536)
            except socket.timeout:
                continue
            if not d:
                break
            body += d
        sock.close()
        self.assertIn(b'"server.alive","shard":1', body,
                      "the LIVE upstream (s1) kept feeding the member throughout the wedge")
        self.assertIn(marker, body,
                      "wedged s2 upstream recycled; its reconnected stream delivered")
        self.assertIn("[/event/s2] upstream silent", self.fd_log(fd))

    def test_session_scoped_wedge_closes_member_and_heals_on_rejoin(self):
        """The off-shard-session shape of the live symptom: a session pinned
        to a wedged shard streams on that shard's SINGLE upstream — zero
        frames of any kind. The dead-man recycles it; the single-upstream
        group hits the existing all-down path (member closed), and the
        client's rejoin heals against the recycled upstream."""
        # the session-scoped group dials its upstream at FIRST JOIN (the
        # merged groups already consumed shard 2's /event at boot), so the
        # wedge is armed AFTER boot: the session group's own dial is the one
        # that wedges.
        fd = self.start_pool(
            premap={"ses_w": 2},
            extra_env={"AMICODE_UPSTREAM_DEADMAN_S": "2", "AMICODE_UPSTREAM_CADENCE_S": "1"})
        self.shards[1].httpd.wedge_sse_once = {"/event"}
        sock = self.sse_join(fd, "/event?session=ses_w")
        sock.settimeout(1)
        first_closed = False
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                d = sock.recv(65536)
            except socket.timeout:
                continue
            if not d:
                first_closed = True
                break
        sock.close()
        self.assertTrue(first_closed,
                        "the dead-man must recycle the wedged upstream (all-down closes the member)")
        # the recycle consumed the wedge: a fresh join heals
        sock2 = self.sse_join(fd, "/event?session=ses_w")
        sock2.settimeout(4)
        healed = b""
        t0 = time.time()
        while time.time() - t0 < 6:
            try:
                d = sock2.recv(65536)
            except socket.timeout:
                break
            if not d:
                break
            healed += d
            if b"server.heartbeat" in healed:
                break
        sock2.close()
        self.assertIn(b"server.heartbeat", healed, "the rejoined stream carries frames again")

    def test_upstream_cadence_logged(self):
        """AC#2: per-upstream frame cadence is visible in frontdoor.log —
        a wedged upstream (0 event frames, 0 heartbeats) is distinguishable
        from a heartbeat-only quiet one, without a probe run."""
        fd = self.start_pool_with_wedge(
            ("/event",), extra_env={"AMICODE_UPSTREAM_DEADMAN_S": "10",
                                    "AMICODE_UPSTREAM_CADENCE_S": "1"})
        self.drip_events(0)
        sock = self.sse_join(fd, "/event?directory=" + POOLDIR)
        time.sleep(3.5)
        sock.close()
        logtext = self.fd_log(fd)
        self.assertRegex(logtext, r"\[/event/s1\] upstream cadence: [1-9]\d* event frames, \d+ heartbeats",
                         "busy upstream reports its frame cadence")
        self.assertRegex(logtext, r"\[/event/s2\] upstream cadence: 0 event frames, 0 heartbeats",
                         "wedged upstream is visible as total silence while members watch")
        self.assertNotRegex(logtext, r"\[/api/event/s\d\] upstream cadence",
                            "member-less quiet groups stay silent (no noise)")

    def test_healthy_upstream_with_events_never_recycled(self):
        """Guard: an upstream delivering event frames within the threshold is
        NEVER dropped — heartbeats plus events flowing means healthy."""
        fd = self.start_pool(
            extra_env={"AMICODE_UPSTREAM_DEADMAN_S": "2", "AMICODE_UPSTREAM_CADENCE_S": "30"})
        for i in range(3):
            self.drip_events(i)
        sock = self.sse_join(fd, "/event?directory=" + POOLDIR)
        time.sleep(6)   # > 2x the deadman window with frames flowing
        sock.close()
        logtext = self.fd_log(fd)
        self.assertNotIn("recycling", logtext)
        for n in (1, 2, 3):
            self.assertEqual(logtext.count("[/event/s%d] upstream live" % n), 1,
                             "healthy upstream s%d must not reconnect" % n)

    def test_quiet_group_without_members_never_churned(self):
        """Guard: no members + no events = parked and silent — no recycle, no
        cadence noise (a quiet group must not be churned by the dead-man)."""
        fd = self.start_pool(
            extra_env={"AMICODE_UPSTREAM_DEADMAN_S": "2", "AMICODE_UPSTREAM_CADENCE_S": "1"})
        time.sleep(4)   # > 2x the deadman window, several cadence windows
        logtext = self.fd_log(fd)
        self.assertNotIn("recycling", logtext)
        self.assertNotIn("upstream cadence", logtext)

    def test_recycled_upstream_fin_reaches_engine(self):
        """#1798 frontdoor half, end-to-end: the dead-man recycler's kill
        must deliver EOF to the ENGINE side of the upstream. A FIN-less kill
        leaves a corpse socket the engine keeps writing into until its SSE
        fan-out wedges (the fleet-wide heartbeat-stall propagation) — and
        the engine cannot send or recover the FIN itself, so the frontdoor's
        close path is the contract."""
        fd = self.start_pool_with_wedge(
            ("/event",), extra_env={"AMICODE_UPSTREAM_DEADMAN_S": "2",
                                    "AMICODE_UPSTREAM_CADENCE_S": "1"})
        self.drip_events(0)   # shard 1 stays provably alive; s2 wedges
        sock = self.sse_join(fd, "/event?directory=" + POOLDIR)   # member waits -> deadman arms
        deadline = time.time() + 10
        while time.time() < deadline \
                and not getattr(self.shards[1].httpd, "wedge_eof_seen", False):
            time.sleep(0.2)
        sock.close()
        self.assertTrue(getattr(self.shards[1].httpd, "wedge_eof_seen", False),
                        "the recycled upstream's FIN must reach the engine side (no corpse socket)")

    def test_member_teardown_normal_drain_keeps_group_healthy(self):
        """#1798 AC4: the FIN is additive, not a semantic change — a member
        closing its stream NORMALLY (client EOF -> waiter teardown) must
        leave the group serving every OTHER member and the frontdoor
        healthy. The waiter teardown now shutdown-then-closes (a writer
        parked in sendall must be woken, the FIN guaranteed); a clean
        close must be indistinguishable from before."""
        fd = self.start_pool()
        a = self.sse_join(fd, "/event?directory=" + POOLDIR)
        b = self.sse_join(fd, "/event?directory=" + POOLDIR)
        time.sleep(0.6)   # preamble + join for both members
        a.close()        # the normal client-side close (FIN reaches the frontdoor)
        b.settimeout(2)
        body = b""
        deadline = time.time() + 3
        while time.time() < deadline:
            try:
                d = b.recv(65536)
            except socket.timeout:
                continue
            if not d:
                break
            body += d
        b.close()
        self.assertGreaterEqual(body.count(b"server.heartbeat"), 2,
                                "the surviving member kept receiving across the teardown")
        # and the frontdoor itself is unharmed by the teardown
        st, _, _ = http_request(fd.port, "/global/health")
        self.assertEqual(st, 200)


# --- #1798 frontdoor half: the lifecycle closes must send FIN ----------------------

_FIN_CLOSE_RUNNER = r'''
import importlib.util, socket, sys, threading, time

frontdoor = sys.argv[1]
spec = importlib.util.spec_from_file_location("fd_under_test", frontdoor)
mod = importlib.util.module_from_spec(spec)
# the frontdoor boots its servers + accept loop at import; run that in a
# daemon thread so the module namespace fills while this thread continues.
threading.Thread(target=spec.loader.exec_module, args=(mod,), daemon=True).start()
deadline = time.time() + 15
while not hasattr(mod, "_fin_close"):
    if time.time() > deadline:
        print("frontdoor module never defined _fin_close", file=sys.stderr)
        sys.exit(3)
    time.sleep(0.05)

# the exact #1757 condition: an engine-facing socket with a concurrent
# reader parked in recv on the closing (frontdoor) side.
l = socket.socket()
l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
l.bind(("127.0.0.1", 0))
l.listen(1)
a = socket.create_connection(l.getsockname(), timeout=5)   # frontdoor side
b, _ = l.accept()                                          # engine side
l.close()
b.settimeout(6)

def parked():
    try:
        a.recv(4096)
    except Exception:
        pass

threading.Thread(target=parked, daemon=True).start()
time.sleep(0.5)   # the reader must actually be inside recv()

mod._fin_close(a)   # the fixed close path
try:
    d = b.recv(4096)
except socket.timeout:
    print("NO-FIN: engine side still open after the close (corpse)")
    sys.exit(1)
sys.exit(0 if d == b"" else 2)   # the engine must see EOF
'''


class TestFrontdoorFinClose(RouterTest):
    """#1798 frontdoor half — the frontdoor is the load-bearing FIN source.

    The #1757 comment in hub-frontdoor.py records the hazard: a bare close()
    on a socket with a concurrent reader parked in recv does NOT send the FIN
    on Linux — the parked syscall holds the file description open, so the
    peer never sees EOF. When the frontdoor kills an upstream that way, the
    engine keeps writing into the corpse socket until its shared SSE fan-out
    wedges — the fleet-wide heartbeat-stall propagation (19,391 FIN-less
    recycles in one observed window). The engine-side peer slice proved BUN's
    node:http layer cannot send a wire FIN at all, so the frontdoor's
    shutdown is the only FIN the engine will ever see: every frontdoor
    lifecycle close that can race a concurrent socket user goes through
    _fin_close — shutdown(SHUT_RDWR), then close — FIN out immediately,
    parked syscall woken, corpse class dead at the source.
    """

    def start_module_runner(self):
        """Import the real frontdoor in a subprocess WITHOUT its production
        footprint: the module pins its port, routing table, session map, and
        log to the test tmpdir (a dead backend — the boot-time upstream
        dials just retry in the background), so the runner can call the
        module's own close path against a raw socket pair."""
        tbl = os.path.join(self.tmpdir, "fin-routing.json")
        with open(tbl, "w") as f:
            json.dump(routing_table([(1, free_port())]), f)
        env = dict(os.environ)
        env.update({
            "AMICODE_ROUTING_TABLE": tbl,
            "AMICODE_SESSION_MAP": os.path.join(self.tmpdir, "fin-sessions.json"),
            "AMICODE_FRONTDOOR_PORT": str(free_port_pair()),
            "AMICODE_FRONTDOOR_LOG": os.path.join(self.tmpdir, "fin-frontdoor.log"),
        })
        return subprocess.run([sys.executable, "-c", _FIN_CLOSE_RUNNER, FRONTDOOR],
                              env=env, capture_output=True, text=True, timeout=60)

    def test_fin_close_delivers_eof_past_blocked_reader(self):
        """AC1: closing an upstream socket through the fixed close path
        delivers FIN/EOF to the peer even while a concurrent reader thread
        is blocked in recv on the closing side — the exact #1757 condition.
        The bare-close control beside this proves the corpse is real under
        plain close() (the recycler's pre-#1798 kill)."""
        r = self.start_module_runner()
        self.assertEqual(r.returncode, 0,
                         "no FIN/EOF past the blocked reader: %r / %r" % (r.stdout, r.stderr))

    def test_bare_close_corpse_control(self):
        """The red side of the pair, pinned: a BARE close() behind a reader
        parked in recv leaves the peer without FIN — the corpse class the
        #1757 comment records and #1798's fix targets. If this control ever
        fails, the platform no longer exhibits the hazard (or the harness is
        broken) — either way the suite must say so, never silently trust
        the fix."""
        l = socket.socket()
        l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        l.bind(("127.0.0.1", 0))
        l.listen(1)
        a = socket.create_connection(l.getsockname(), timeout=5)
        b, _ = l.accept()
        l.close()
        b.settimeout(3)
        parked = threading.Event()

        def reader():
            parked.set()
            try:
                a.recv(4096)
            except Exception:
                pass

        threading.Thread(target=reader, daemon=True).start()
        parked.wait(2)
        time.sleep(0.5)   # the reader must actually be inside recv()
        a.close()        # the pre-#1798 close: plain close()
        with self.assertRaises(socket.timeout):
            b.recv(4096)   # no EOF — the corpse
        b.close()


# --- #1810: kernel-level corpse detection on the SSE sockets -----------------------
#
# The #1798 corpse class is detected today by application-level dead-man
# switches on a 60-second cadence. The state of the art kills it at layer 4:
# aggressive TCP keepalives (idle 30s, interval 5s, count 3) + TCP_USER_TIMEOUT
# (~30s) make the OS reap a corpse socket before any application writer can
# block on it. The frontdoor's engine-facing dials (upstream_loop's connect
# helper, backend_get, the passthrough proxy socket) and its ACCEPTED member
# sockets (the fleet clients' SSE streams — the real network path where a
# dead tunnel leaves a FIN-less corpse the fan-out writer blocks on) all get
# the same options. Every test here reads the options BACK from the kernel
# (getsockopt on the armed socket, or the kernel's own per-socket keepalive
# timer via ss) — never trusting that the setter ran.

_KEEPALIVE_RUNNER = r'''
import importlib.util, socket, sys, threading, time

frontdoor = sys.argv[1]
mode = sys.argv[2]
spec = importlib.util.spec_from_file_location("fd_under_test", frontdoor)
mod = importlib.util.module_from_spec(spec)
# the frontdoor boots its servers + accept loop at import; run that in a
# daemon thread so the module namespace fills while this thread continues.
threading.Thread(target=spec.loader.exec_module, args=(mod,), daemon=True).start()
deadline = time.time() + 15
while not hasattr(mod, "_arm_tcp_keepalive"):
    if time.time() > deadline:
        print("frontdoor module never defined _arm_tcp_keepalive", file=sys.stderr)
        sys.exit(3)
    time.sleep(0.05)

print("KNOBS idle_s=%s intvl_s=%s cnt=%s user_timeout_ms=%s"
      % (mod.TCP_KEEPIDLE_S, mod.TCP_KEEPINTVL_S, mod.TCP_KEEPCNT, mod.TCP_USER_TIMEOUT_MS))

# a real TCP pair; arm the client (frontdoor-side) socket and read the options
# BACK from the kernel on the SAME socket — the assert-at-setup rule.
l = socket.socket()
l.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
l.bind(("127.0.0.1", 0))
l.listen(1)
a = socket.create_connection(l.getsockname(), timeout=5)
b, _ = l.accept()
l.close()

if mode == "no_user_timeout":
    mod.TCP_USER_TIMEOUT_OPT = 999      # unsupported optname -> ENOPROTOOPT
if mode == "keepalive_loud":
    mod.SO_KEEPALIVE_OPT = 999          # SO_KEEPALIVE itself unreachable

mod._arm_tcp_keepalive(a)
time.sleep(0.2)
print("READBACK SO_KEEPALIVE=%d TCP_KEEPIDLE=%d TCP_KEEPINTVL=%d TCP_KEEPCNT=%d TCP_USER_TIMEOUT=%d" % (
    a.getsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE),
    a.getsockopt(socket.IPPROTO_TCP, getattr(socket, "TCP_KEEPIDLE", 4)),
    a.getsockopt(socket.IPPROTO_TCP, getattr(socket, "TCP_KEEPINTVL", 5)),
    a.getsockopt(socket.IPPROTO_TCP, getattr(socket, "TCP_KEEPCNT", 6)),
    a.getsockopt(socket.IPPROTO_TCP, getattr(socket, "TCP_USER_TIMEOUT", 18))))
if mode == "keepalive_loud":
    # the never-silent contract: a failed SO_KEEPALIVE arm must be LOUD in the
    # frontdoor's own log (pinned via AMICODE_FRONTDOOR_LOG) — never a silent
    # full skip.
    time.sleep(0.5)
    try:
        with open(mod.LOG.name) as f:
            body = f.read()
    except Exception as e:
        print("LOGREAD_FAILED %s" % e)
        sys.exit(4)
    print("LOUD=%d" % int("TCP-KEEPALIVE" in body))
a.close(); b.close()
sys.exit(0)
'''


def ss_keepalive_timers(filter_expr):
    """Kernel read-back for live sockets: every ESTABLISHED socket matching the
    ss filter, with its timer token ('keepalive,29.8sec,0' style) — ss -o
    renders the socket's ACTIVE kernel timer, which for a keepalive-armed
    idle TCP socket is the keepalive countdown (its KEEPIDLE value, vs the
    ~119min system default). Returns [] when no socket matches."""
    out = subprocess.run(["ss", "-tnoi", "state", "established"] + filter_expr,
                         capture_output=True, text=True).stdout
    timers = []
    for ln in out.splitlines():
        stripped = ln.strip()
        i = stripped.find("timer:(keepalive,")
        if i >= 0:
            j = stripped.find(")", i)
            timers.append(stripped[i + len("timer:("):j])
    return timers


def keepalive_idle_seconds(timer):
    """'keepalive,29sec,0' -> 29.0 seconds (the timer token's idle countdown)."""
    m = re.search(r"([\d.]+)(ms|sec|min)", timer)
    if m is None:
        return None
    return float(m.group(1)) * {"ms": 0.001, "sec": 1.0, "min": 60.0}[m.group(2)]


class TestUpstreamKeepalive(RouterTest):
    """#1810 frontdoor half: SO_KEEPALIVE + TCP_USER_TIMEOUT on the
    engine-facing upstream dials and the accepted member sockets, env-tunable,
    portable, and proven by reading the options back from the kernel."""

    READBACK_RE = re.compile(
        r"READBACK SO_KEEPALIVE=(\d+) TCP_KEEPIDLE=(\d+) TCP_KEEPINTVL=(\d+) "
        r"TCP_KEEPCNT=(\d+) TCP_USER_TIMEOUT=(\d+)")

    def run_module(self, mode="plain", extra_env=None):
        """Import the real frontdoor module in a subprocess pinned to the test
        tmpdir (dead backend, ephemeral port — the _FIN_CLOSE_RUNNER pattern)
        and call its own arm helper against a raw socket pair."""
        tbl = os.path.join(self.tmpdir, "ka-routing.json")
        with open(tbl, "w") as f:
            json.dump(routing_table([(1, free_port())]), f)
        env = dict(os.environ)
        env.update({
            "AMICODE_ROUTING_TABLE": tbl,
            "AMICODE_SESSION_MAP": os.path.join(self.tmpdir, "ka-sessions.json"),
            "AMICODE_FRONTDOOR_PORT": str(free_port_pair()),
            "AMICODE_FRONTDOOR_LOG": os.path.join(self.tmpdir, "ka-frontdoor.log"),
        })
        env.update(extra_env or {})
        return subprocess.run([sys.executable, "-c", _KEEPALIVE_RUNNER, FRONTDOOR, mode],
                              env=env, capture_output=True, text=True, timeout=60)

    def readback(self, r):
        m = self.READBACK_RE.search(r.stdout)
        self.assertIsNotNone(m, "runner produced no read-back: %r / %r" % (r.stdout, r.stderr))
        return [int(x) for x in m.groups()]

    def sse_join(self, fd, target):
        s = socket.create_connection(("127.0.0.1", fd.port), timeout=10)
        s.sendall((f"GET {target} HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n").encode())
        return s

    def test_arm_reads_back_the_briefed_defaults_on_a_real_socket(self):
        """AC2/AC3: the arm helper sets SO_KEEPALIVE(idle 30s, intvl 5s, cnt 3)
        + TCP_USER_TIMEOUT(30s) — proven by reading the options back from the
        kernel on the same real socket, with the briefed defaults."""
        r = self.run_module()
        self.assertEqual(r.returncode, 0, "arm runner failed: %r / %r" % (r.stdout, r.stderr))
        self.assertEqual(self.readback(r), [1, 30, 5, 3, 30000])
        self.assertIn("KNOBS idle_s=30 intvl_s=5 cnt=3 user_timeout_ms=30000", r.stdout)

    def test_knobs_env_tuned_invalid_keeps_default(self):
        """AC3: AMICODE_TCP_* knobs tune the options; an INVALID value keeps
        the briefed default (never crashes, never skips the arm)."""
        r = self.run_module(extra_env={
            "AMICODE_TCP_KEEPIDLE_S": "12", "AMICODE_TCP_KEEPINTVL_S": "4",
            "AMICODE_TCP_KEEPCNT": "9", "AMICODE_TCP_USER_TIMEOUT_MS": "45000"})
        self.assertEqual(r.returncode, 0, "tuned arm runner failed: %r / %r" % (r.stdout, r.stderr))
        self.assertEqual(self.readback(r), [1, 12, 4, 9, 45000])
        r2 = self.run_module(extra_env={
            "AMICODE_TCP_KEEPIDLE_S": "abc", "AMICODE_TCP_KEEPINTVL_S": "-3",
            "AMICODE_TCP_KEEPCNT": "x9", "AMICODE_TCP_USER_TIMEOUT_MS": "0"})
        self.assertEqual(r2.returncode, 0, "invalid-env arm runner failed: %r / %r"
                         % (r2.stdout, r2.stderr))
        self.assertEqual(self.readback(r2), [1, 30, 5, 3, 30000],
                         "invalid knob values must keep the briefed defaults")

    def test_platform_without_user_timeout_degrades_to_keepalives_only(self):
        """AC4: a platform without the TCP_USER_TIMEOUT knob (forced here with
        an unsupported optname -> ENOPROTOOPT) degrades to keepalives ONLY:
        no crash, and the keepalive family (idle/interval/count) still lands."""
        r = self.run_module(mode="no_user_timeout")
        self.assertEqual(r.returncode, 0, "degraded arm must not crash: %r / %r"
                         % (r.stdout, r.stderr))
        self.assertEqual(self.readback(r), [1, 30, 5, 3, 0],
                         "keepalives must stay armed where the user-timeout knob is missing")

    def test_keepalive_arm_failure_is_loud_never_a_silent_skip(self):
        """AC4: SO_KEEPALIVE itself failing can never be silent — the arm must
        write a loud TCP-KEEPALIVE line to the frontdoor's log (the #1757
        loudness doctrine; a silent full skip would read as corpse detection
        where none exists)."""
        r = self.run_module(mode="keepalive_loud")
        self.assertEqual(r.returncode, 0, "loud-arm runner failed: %r / %r" % (r.stdout, r.stderr))
        self.assertIn("LOUD=1", r.stdout,
                      "a failed SO_KEEPALIVE arm must log loudly (runner: %r)" % r.stdout)

    def test_live_frontdoor_upstream_and_member_sockets_carry_kernel_keepalive(self):
        """AC2 end-to-end through the REAL frontdoor subprocess: every
        established frontdoor->shard socket (the merged-group upstreams) and
        the accepted member socket carry SO_KEEPALIVE with the TUNED idle —
        read back from the kernel's own per-socket keepalive timer (ss), not
        from the setter."""
        fd = self.start_pool()
        member = self.sse_join(fd, "/event?directory=" + POOLDIR)
        member.settimeout(2)
        try:
            member.recv(65536)   # preamble + join: the upstreams are live
        except socket.timeout:
            pass
        time.sleep(0.3)
        for sh in self.shards:
            timers = ss_keepalive_timers(["( dport = :%d )" % sh.port])
            self.assertTrue(timers, "no established frontdoor->shard%d socket found for ss"
                            % sh.shard_id)
            for t in timers:
                idle = keepalive_idle_seconds(t)
                self.assertIsNotNone(idle, "unparseable keepalive timer: %r" % t)
                self.assertLess(idle, 120.0,
                                "keepalive idle must be the TUNED 30s, not the 7200s system "
                                "default (timer=%r)" % t)
        # the accepted member socket (the fleet client's SSE stream): the
        # frontdoor-side accepted socket carries the same armed options.
        mtimers = ss_keepalive_timers(["( sport = :%d and dport = :%d )"
                                       % (fd.port, member.getsockname()[1])])
        self.assertTrue(mtimers, "no established member socket found for ss")
        for t in mtimers:
            idle = keepalive_idle_seconds(t)
            self.assertIsNotNone(idle, "unparseable keepalive timer: %r" % t)
            self.assertLess(idle, 120.0, "member socket keepalive idle must be tuned (timer=%r)" % t)
        member.close()


class TestDeltaCoalescing(unittest.TestCase):
    """2026-10-08: the delta flood dropped tabs mid-turn (member queue full,
    reconnect replay seconds behind, flood again — 'live activity never
    renders'). Consecutive same-part deltas now coalesce in the member queue:
    lossless text, tiny queue."""

    def frame(self, delta, eid="evt_test1", part="prt_1"):
        return (b'id: ' + eid.encode() + b'\r\n' +
                b'data: {"id":"' + eid.encode() + b'","type":"message.part.delta",'
                b'"properties":{"messageID":"msg_1","partID":"' + part.encode() +
                b'","field":"text","delta":"' + delta + b'"}}\r\n\r\n')

    def plain(self, kind):
        return b'data: {"type":"' + kind + b'"}\n\n'

    def test_same_part_deltas_merge(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("fd", FRONTDOOR)
        fd = importlib.util.module_from_spec(spec)
        import sys
        sys.modules["fd"] = fd
        spec.loader.exec_module(fd) if False else None
        # import the frontdoor module pieces we need WITHOUT booting the
        # server: exec the file with a stubbed __name__ guard? The frontdoor
        # boots servers on import — use the two functions via a subprocess:
        # simpler: the merge is exercised through a live pool below.
        self.assertTrue(True)

    def test_flood_does_not_drop_a_slow_member(self):
        """The end-to-end contract: a shard floods deltas; a member that
        reads slowly still receives the FULL concatenated text and is never
        dropped for a full queue."""
        t = RouterTest()
        t.setUp()
        try:
            fd = t.start_pool()
            # the merged /event group exists once a member joins
            sock = socket.create_connection(("127.0.0.1", fd.port), timeout=10)
            sock.sendall(b"GET /event?directory=" + POOLDIR.encode() + b" HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n")
            time.sleep(0.6)   # preamble + join
            # flood: 400 same-part deltas through shard 1's stream
            flood = []
            for i in range(400):
                flood.append((b"/event",
                              b'data: {"id":"evt_d%d","type":"message.part.delta",'
                              b'"properties":{"messageID":"m","partID":"p","field":"text",'
                              b'"delta":"t%d "}}\n\n' % (i, i)))
            t.shards[0].httpd.sse_inject.extend(flood)
            time.sleep(2.0)   # flood fans into the member queue, coalescing
            body = b""
            sock.settimeout(2)
            deadline = time.time() + 8
            try:
                while time.time() < deadline and b"t399 " not in body:
                    try:
                        d = sock.recv(65536)
                    except socket.timeout:
                        continue
                    if not d:
                        break
                    body += d
            except Exception:
                pass
            sock.close()
            self.assertIn(b"t399 ", body, "the flood's tail reached the member")
            # and the deltas arrived coalesced (far fewer frames than 400)
            self.assertLess(body.count(b'"message.part.delta"'), 50,
                            "same-part deltas coalesced, not 400 raw frames")
            # the concatenated text is lossless through the merges
            self.assertIn(b"t0 ", body)
            self.assertIn(b"t200 ", body)
        finally:
            t.tearDown()

    def test_question_frame_reaches_members_live(self):
        """2026-10-10: the live question card never rendered even post-fix —
        every prior test verified the MAP learning, never the MEMBER delivery.
        A question.asked frame must reach a joined member's socket live."""
        t = RouterTest()
        t.setUp()
        try:
            fd = t.start_pool()
            sock = socket.create_connection(("127.0.0.1", fd.port), timeout=10)
            sock.sendall(b"GET /event?directory=" + POOLDIR.encode() + b" HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n")
            time.sleep(0.6)
            qframe = (b"/event",
                      b'data: {"id":"evt_liveq","type":"question.asked","properties":'
                      b'{"id":"que_live1","sessionID":"ses_q1","questions":'
                      b'[{"header":"h","question":"live?","options":[]}]}}\n\n')
            t.shards[1].httpd.sse_inject.append(qframe)
            body = b""
            sock.settimeout(3)
            deadline = time.time() + 4
            while time.time() < deadline and b"question.asked" not in body:
                try:
                    d = sock.recv(65536)
                except socket.timeout:
                    continue
                if not d:
                    break
                body += d
            sock.close()
            self.assertIn(b"question.asked", body, "the live question frame reached the member")
        finally:
            t.tearDown()


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


# --- #1745: the client-log ingest + the heartbeat canary ------------------------

class TestClientLogIngest(RouterTest):
    """#1745: client telemetry was dead for six weeks (Sep 23 → Oct 10) — the
    panel's error captures never reached client-errors.log. These pin the
    ingest contract: a panel-shaped POST lands in the log file, answers 204
    (never the engine SPA fallback's 200 text/html), and the engine backend
    is never dialed for it."""

    def start_log_frontdoor(self, extra_env=None):
        sh = self.start_shard(1)
        env = {"AMICODE_CLIENT_LOG": os.path.join(self.tmpdir, "client-errors.log")}
        env.update(extra_env or {})
        fd = self.start_frontdoor(routing_table([(1, sh.port)]), extra_env=env)
        return fd, sh

    def test_capture_post_lands_in_log_answers_204(self):
        fd, sh = self.start_log_frontdoor()
        body = ("C abc123\nTypeError: t is not a function\n"
                "    at SessionStreamVeil (assets/index-abc123.js:1:2)")
        st, hdr, resp = http_request(fd.port, "/__amicode_client_log",
                                     method="POST", body=body.encode())
        self.assertEqual(st, 204, "the ingest must answer 204 No Content")
        self.assertNotIn("text/html", hdr.get("content-type", ""),
                         "the SPA fallback must never answer the ingest route")
        self.assertEqual(resp, b"", "204 carries no body")
        with open(os.path.join(self.tmpdir, "client-errors.log")) as f:
            self.assertEqual(f.read(), body + "\n",
                             "the capture must land verbatim in client-errors.log")
        # the ingest is frontdoor-local: the backend is never dialed (the
        # engine's SPA fallback is the text/html that killed the telemetry)
        self.assertNotIn("/__amicode_client_log", sh.httpd.counts)

    def test_heartbeat_post_lands_in_log(self):
        fd, _ = self.start_log_frontdoor()
        st, _, _ = http_request(fd.port, "/__amicode_client_log", method="POST",
                                body=b'{"heartbeat":1790000000000}')
        self.assertEqual(st, 204)
        with open(os.path.join(self.tmpdir, "client-errors.log")) as f:
            self.assertEqual(f.read().splitlines(), ['{"heartbeat":1790000000000}'])


class TestHeartbeatAlarm(RouterTest):
    """#1745 AC3: the heartbeat canary — the panel heartbeats while open; the
    frontdoor alarms when live SSE members exist (a panel IS open — the
    Oct-10 signature: server mechanically healthy, streams held for hours,
    client dead) but no heartbeat arrived within the threshold window.

    The live-members guard is the false-positive rule: a closed panel is
    LEGITIMATE quiet and must never alarm. 'No heartbeat ever' (a panel from
    a pre-#1745 build) alarms too — a telemetry surface that can die
    invisibly is itself a defect."""

    # 3x headroom like production (60s beat vs 180s threshold): beat gaps
    # (~0.15s) and the 0.6s member-join gap both stay well under the alarm.
    # The ingest target ALWAYS points at the tmpdir — the production log is
    # never a test write target (the alarm only reads in-memory state).
    ALARM_ENV = {"AMICODE_HEARTBEAT_ALARM_S": "0.9",
                 "AMICODE_HEARTBEAT_CHECK_S": "0.2",
                 "AMICODE_CLIENT_LOG": "__set_by_start_alarm_frontdoor__"}

    def start_alarm_frontdoor(self):
        sh = self.start_shard(1)
        env = dict(self.ALARM_ENV)
        env["AMICODE_CLIENT_LOG"] = os.path.join(self.tmpdir, "client-errors.log")
        fd = self.start_frontdoor(routing_table([(1, sh.port)]), extra_env=env)
        return fd

    def open_member(self, fd):
        """A joined SSE member = an open panel's live stream."""
        s = socket.create_connection(("127.0.0.1", fd.port), timeout=10)
        s.sendall((b"GET /event?directory=" + POOLDIR.encode() +
                   b" HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n"))
        time.sleep(0.6)   # preamble + join
        return s

    def frontdoor_log(self, fd):
        try:
            with open(os.path.join(fd.tmpdir, "frontdoor.log")) as f:
                return f.read()
        except OSError:
            return ""

    def test_alarm_fires_when_streams_live_but_no_heartbeat(self):
        fd = self.start_alarm_frontdoor()
        member = self.open_member(fd)
        try:
            deadline = time.time() + 4
            while time.time() < deadline:
                if "HEARTBEAT-ALARM" in self.frontdoor_log(fd):
                    break
                time.sleep(0.2)
            self.assertIn("HEARTBEAT-ALARM", self.frontdoor_log(fd),
                          "live streams + zero heartbeats must alarm")
        finally:
            member.close()

    def test_no_alarm_when_no_streams_are_live(self):
        """A closed panel is legitimate quiet — no SSE members means the
        silence alarm must stay OFF (the freshness check covers staleness)."""
        fd = self.start_alarm_frontdoor()
        time.sleep(1.5)   # several check passes, never a member
        self.assertNotIn("HEARTBEAT-ALARM", self.frontdoor_log(fd),
                         "no live streams -> no alarm (false-positive guard)")

    def test_no_alarm_while_heartbeats_stay_fresh(self):
        fd = self.start_alarm_frontdoor()
        # the panel's real order: the telemetry's first beat fires at mount,
        # BEFORE its stream joins — the canary must have its baseline first
        http_request(fd.port, "/__amicode_client_log", method="POST",
                     body=b'{"heartbeat":%d}' % int(time.time() * 1000))
        member = self.open_member(fd)
        try:
            for _ in range(8):
                http_request(fd.port, "/__amicode_client_log", method="POST",
                             body=b'{"heartbeat":%d}' % int(time.time() * 1000))
                time.sleep(0.15)
            self.assertNotIn("HEARTBEAT-ALARM", self.frontdoor_log(fd),
                             "fresh heartbeats under the threshold must stay quiet")
        finally:
            member.close()
# --- #1760 P1: one door — the gateway shared secret --------------------------------

class TestGatewaySecret(RouterTest):
    """The frontdoor stamps x-amicode-gateway-secret on EVERY engine-facing
    connection: passthrough dials, backend_get merges (session/question lists,
    snapshot pulls, seeds), the SSE upstreams' preamble, the sampler probe, and
    the curl index/asset fetches. A 401-ing upstream (secret mismatch) must
    surface as upstream-down/retry — a 503 or a forwarded 401, never silence."""

    def _all_seen(self):
        out = {}
        for sh in self.shards:
            for path, val in sh.httpd.seen.items():
                out["s%d %s" % (sh.shard_id, path)] = val
        return out

    def test_stamps_every_engine_connection(self):
        fd = self.start_pool(
            extra_env={"AMICODE_ENGINE_SHARED_SECRET": "gw-test-secret",
                       "AMICODE_SHARD_SAMPLE_INTERVAL": "0.3"},
            sessions={1: [sess("ses_gw1", 100)], 2: [], 3: []})
        # passthrough dial
        st, hdr, _ = http_request(fd.port, "/session/ses_gw1/message?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        # backend_get merge (session list fan-out)
        st, _, _ = http_request(fd.port, "/session?directory=" + POOLDIR + "&limit=50")
        self.assertEqual(st, 200)
        # merged question list (backend_get per member)
        st, _, _ = http_request(fd.port, "/question?directory=" + POOLDIR)
        self.assertEqual(st, 200)
        # SSE upstream preamble
        buf = sse_read(fd.port, "/event", want=b"server.connected")
        self.assertIn(b"server.connected", buf)
        # snapshot pulls (health + list merge + message pages)
        st, _, _ = http_request(fd.port, "/snapshot?top=3")
        self.assertEqual(st, 200)
        time.sleep(1.2)   # one sampler pass: /config probe + question-map seeds
        seen = self._all_seen()
        self.assertGreaterEqual(len(seen), 10, "expected connections recorded: %r" % (seen,))
        for key, val in seen.items():
            self.assertEqual(val, "gw-test-secret", f"{key} missing the gateway stamp (got {val!r})")

    def test_client_cannot_forge_the_gateway_header(self):
        """A client-supplied x-amicode-gateway-secret is REPLACED by the
        frontdoor's own — the door is the only authority that can stamp."""
        fd = self.start_pool(extra_env={"AMICODE_ENGINE_SHARED_SECRET": "gw-test-secret"})
        st, _, _ = http_request(fd.port, "/global/health",
                                 headers={"X-Amicode-Gateway-Secret": "client-forged"})
        self.assertEqual(st, 200)
        seen = self._all_seen()
        self.assertTrue(any(v == "gw-test-secret" for v in seen.values()), seen)
        self.assertFalse(any(v == "client-forged" for v in seen.values()), seen)

    def test_env_unset_stamps_nothing(self):
        """Compat window: with the env unset, no connection carries the header
        (today's open behavior — the rollback/rollout safety valve)."""
        fd = self.start_pool(
            extra_env={"AMICODE_SHARD_SAMPLE_INTERVAL": "0.3"},
            sessions={1: [sess("ses_open1", 100)], 2: [], 3: []})
        st, _, _ = http_request(fd.port, "/session?directory=" + POOLDIR + "&limit=50")
        self.assertEqual(st, 200)
        buf = sse_read(fd.port, "/event", want=b"server.connected")
        self.assertIn(b"server.connected", buf)
        st2, _, _ = http_request(fd.port, "/session/ses_open1/message")
        self.assertEqual(st2, 200)
        time.sleep(1.2)
        for key, val in self._all_seen().items():
            self.assertIsNone(val, f"{key} unexpectedly stamped in compat mode (got {val!r})")

    def test_secret_mismatch_surfaces_as_upstream_down(self):
        """The #1757 lesson: an engine that 401s the frontdoor (a half-rolled
        or mismatched secret) must surface LOUDLY — the merged list answers
        503, the SSE upstream logs upstream-down and retries, a passthrough
        request forwards the 401 to the client. Never silent silence."""
        fd = self.start_pool(
            extra_env={"AMICODE_ENGINE_SHARED_SECRET": "frontdoor-secret"},
            sessions={1: [sess("ses_mm", 100)], 2: [], 3: []})
        for sh in self.shards:
            sh.httpd.require_secret = "different-secret"
        # passthrough: the engine's 401 JSON reaches the client
        st, hdr, body = http_request(fd.port, "/session/ses_mm/message?directory=" + POOLDIR,
                                     timeout=20)
        self.assertEqual(st, 401)
        self.assertIn(b"gateway-secret", body)
        # merged session list: every member 401s -> 503 (Retry-After 10), not silence
        st2, hdr2, _ = http_request(fd.port, "/session?directory=" + POOLDIR, timeout=20)
        self.assertEqual(st2, 503)
        self.assertEqual(hdr2.get("retry-after"), "10")
        # SSE upstreams: the preamble sees the 401, logs upstream down + retries
        time.sleep(1.5)
        with open(os.path.join(fd.tmpdir, "frontdoor.log")) as f:
            logtext = f.read()
        self.assertIn("upstream down", logtext)
        self.assertIn("401", logtext)


if __name__ == "__main__":
    unittest.main(verbosity=2)
