#!/usr/bin/env python3
"""test_frontdoor_e2e.py — the #1803 P1b lossless-resume E2E.

The acceptance the P1 port list requires (#1803: "the lossless-resume E2E
from main's #1770 acceptance — kill the link mid-turn, reconnect,
transcript equals fresh load — run against THIS lane's sharded hub"):
real engines (bun, from this branch's materialized tree), the real frontdoor
in sharded mode, a member through the frontdoor, the link killed mid-stream
(here at its strongest: the FRONTDOOR itself dies mid-absence — the
middle-hop death the frontdoor ring could never survive, the P1 thesis),
the member reconnecting with its last id, and the gap served EXACTLY by the
engine's replay through the passthrough (no loss, no dupes — mechanical via
the epoch:seq ids), with a fresh-load comparison member producing an
identical transcript.

Scratch discipline: every engine gets its own XDG (own DB, own epoch), the
frontdoor's routing table/log/map live in a temp dir, every port is
ephemeral. The hub's running engines are NEVER touched; no BUN inspector
env leaks in (unset at every spawn).

Run: python3 ops/hub/test_frontdoor_e2e.py    (exit 0 on pass)
Skip: the materialized engine tree missing, or AMICODE_P1B_SKIP_E2E=1.
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

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTDOOR = os.path.join(HERE, "hub-frontdoor.py")
REPO = os.path.dirname(os.path.dirname(HERE))            # the worktree root
MATERIALIZED = os.path.join(REPO, "packages", "app-bundle", ".materialized",
                            "packages", "opencode")
KEEP = bool(os.environ.get("AMICODE_TEST_KEEPDIR"))

CONTROL_TYPES = ("server.connected", "server.heartbeat", "state.resync",
                 "server.cursor.unservable")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def free_port_pair():
    while True:
        p = free_port()
        s = socket.socket()
        try:
            s.bind(("0.0.0.0", p + 1))
            s.close()
            return p
        except OSError:
            s.close()


def scrub_env(env):
    """The env-scrub rule for engine tooling: no inspector, no shard env."""
    for k in ("BUN_INSPECT", "BUN_INSPECT_NOTIFY", "AMICODE_SHARD_INDEX"):
        env.pop(k, None)
    return env


class Engine:
    """A real opencode engine (bun serve) on a scratch port + scratch XDG:
    its own DB, its own <epoch>:<seq> bus — a real shard, isolated."""

    def __init__(self, tmpdir, shard_id):
        self.shard_id = shard_id
        self.port = free_port()
        self.xdg = os.path.join(tmpdir, "engine%d-xdg" % shard_id)
        os.makedirs(self.xdg, exist_ok=True)
        self.log_path = os.path.join(tmpdir, "engine%d.log" % shard_id)
        self.proc = None

    def start(self):
        env = scrub_env(dict(os.environ))
        env["XDG_DATA_HOME"] = self.xdg
        env["XDG_CONFIG_HOME"] = self.xdg
        env.pop("OPENCODE_SERVER_PASSWORD", None)   # scratch loopback: open
        out = open(self.log_path, "ab")
        self.proc = subprocess.Popen(
            ["bun", "run", "--conditions=browser", "./src/index.ts",
             "serve", "--port", str(self.port), "--hostname", "127.0.0.1"],
            cwd=MATERIALIZED, env=env, stdout=out, stderr=subprocess.STDOUT)
        deadline = time.time() + 30
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise AssertionError("engine s%d died at boot (rc=%s): %s"
                                     % (self.shard_id, self.proc.poll(),
                                        open(self.log_path).read()[-2000:]))
            try:
                s = socket.create_connection(("127.0.0.1", self.port), timeout=1)
                s.sendall(b"GET /global/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                buf = b""
                while b"\r\n\r\n" not in buf:
                    d = s.recv(4096)
                    if not d:
                        break
                    buf += d
                s.close()
                if b" 200 " in buf.split(b"\r\n", 1)[0]:
                    return
            except OSError:
                pass
            time.sleep(0.2)
        raise AssertionError("engine s%d not healthy in 30s" % self.shard_id)

    def stop(self):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)

    def create_session(self, directory, title):
        """Generate a REAL bus event (session.created) on this engine — the
        event generator a model-free E2E can drive honestly; the lossless
        mechanics (bus -> replay buffer -> cursor replay) are identical for
        every event type."""
        body = json.dumps({"title": title}).encode()
        req = (b"POST /session?directory=" + directory.encode() +
               b" HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"
               b"Content-Type: application/json\r\nContent-Length: "
               + str(len(body)).encode() + b"\r\n\r\n" + body)
        s = socket.create_connection(("127.0.0.1", self.port), timeout=30)
        try:
            s.sendall(req)
            buf = b""
            while True:
                d = s.recv(65536)
                if not d:
                    break
                buf += d
        finally:
            s.close()
        head = buf.split(b"\r\n", 1)[0]
        if b" 200 " not in head and b" 201 " not in head:
            raise AssertionError("create_session failed: %r" % buf[:400])
        return json.loads(buf.split(b"\r\n\r\n", 1)[1].decode())["id"]


class Member:
    """A raw SSE member through the frontdoor — the panel's wire shape (no
    EventSource magic, just the bytes and the cursor)."""

    def __init__(self, fd_port, target, cursor_query=None, cursor_header=None):
        if cursor_query is not None:
            target += ("&" if "?" in target else "?") + "lastEventID=" + cursor_query
        req = (f"GET {target} HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n")
        if cursor_header is not None:
            req += f"Last-Event-ID: {cursor_header}\r\n"
        s = socket.create_connection(("127.0.0.1", fd_port), timeout=15)
        s.sendall((req + "\r\n").encode())
        self.sock = s
        self.buf = b""
        self.frames = []       # (sse_id, payload_id, type) — control frames included
        self.stop_flag = False

    def _pump(self, timeout=0.4):
        self.sock.settimeout(timeout)
        deadline = time.time() + timeout
        while time.time() < deadline and not self.stop_flag:
            try:
                d = self.sock.recv(65536)
            except socket.timeout:
                return False
            if not d:
                self.stop_flag = True
                return False
            self.buf += d
            self._parse()
            return True
        return False

    def _parse(self):
        while b"\n\n" in self.buf:
            raw, self.buf = self.buf.split(b"\n\n", 1)
            sse_id = payload_id = evtype = None
            data = None
            for ln in raw.split(b"\n"):
                if ln.startswith(b"id:"):
                    sse_id = ln[3:].strip().decode("utf-8", "replace")
                elif ln.startswith(b"data:"):
                    try:
                        data = json.loads(ln[5:].strip())
                    except Exception:
                        continue
                    payload_id = data.get("id") if isinstance(data, dict) else None
                    evtype = data.get("type") if isinstance(data, dict) else None
            self.frames.append((sse_id, payload_id, evtype, data))

    def read_until(self, cond, timeout=20):
        """Pump until cond(frames) is true (or timeout). Returns the frames."""
        deadline = time.time() + timeout
        while time.time() < deadline and not self.stop_flag:
            if cond(self.frames):
                return self.frames
            self._pump()
        return self.frames

    def events(self, epoch=None):
        """The event frames (non-control), optionally scoped to one epoch."""
        out = []
        for sse_id, pid, evtype, _data in self.frames:
            if evtype in CONTROL_TYPES or evtype is None:
                continue
            if epoch is not None and not (sse_id or "").startswith(epoch + ":"):
                continue
            out.append((sse_id, pid, evtype))
        return out

    def session_titles_seen(self):
        return [pid for _, pid, _ in self.events()]

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


class Frontdoor:
    """The real frontdoor subprocess, sharded over the two engines."""

    def __init__(self, tmpdir, engines, pool_dir):
        self.tmpdir = tmpdir
        self.port = free_port_pair()
        self.table = os.path.join(tmpdir, "routing.json")
        with open(self.table, "w") as f:
            json.dump({
                "shards": [{"id": e.shard_id, "backend": "127.0.0.1:%d" % e.port}
                           for e in engines],
                "default_shard": 1,
                "directory_pools": {pool_dir: [e.shard_id for e in engines]},
            }, f)
        self.env = scrub_env(dict(os.environ))
        self.env.update({
            "AMICODE_ROUTING_TABLE": self.table,
            "AMICODE_SESSION_MAP": os.path.join(tmpdir, "routing-sessions.json"),
            "AMICODE_FRONTDOOR_PORT": str(self.port),
            "AMICODE_FRONTDOOR_LOG": os.path.join(tmpdir, "frontdoor.log"),
        })
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

    def log(self):
        try:
            with open(os.path.join(self.tmpdir, "frontdoor.log")) as f:
                return f.read()
        except OSError:
            return ""


class TestLosslessResumeE2E(unittest.TestCase):
    """The P1b acceptance, finally run live: mid-stream kill, reconnect with
    the cursor, the transcript is EXACTLY the gap and equals a fresh load —
    through the real frontdoor against real engines."""

    def setUp(self):
        if os.environ.get("AMICODE_P1B_SKIP_E2E"):
            self.skipTest("AMICODE_P1B_SKIP_E2E set")
        if not os.path.isdir(MATERIALIZED):
            self.skipTest("materialized engine tree absent — run "
                          "materialize.mjs + bun install to enable the E2E")
        self.tmpdir = tempfile.mkdtemp(prefix="frontdoor-e2e-")
        self.addCleanup(self._teardown)
        self.workdir = os.path.join(self.tmpdir, "proj")
        os.makedirs(self.workdir, exist_ok=True)
        self.engines = []
        for sid in (1, 2):
            e = Engine(self.tmpdir, sid)
            self.engines.append(e)
            e.start()
        # warm the instance on the shard that will generate events (the
        # first request with ?directory spins it up — pay that cost here,
        # BEFORE the frontdoor boots: an event landing in the frontdoor's
        # parked upstream preamble window would ride its cached preamble to
        # every fresh join, and the E2E counts frames exactly)
        self.engines[0].create_session(self.workdir, "warmup")
        self.fd = Frontdoor(self.tmpdir, self.engines, self.workdir)
        self.fd.start()

    def _teardown(self):
        self.fd.stop()
        for e in self.engines:
            e.stop()
        if KEEP:
            print("\nKEPT E2E dir: %s" % self.tmpdir)
        else:
            shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_midstream_kill_reconnect_transcript_equals_fresh_load(self):
        e1, e2 = self.engines
        # --- live phase: the member watches real events through the door ---
        a = Member(self.fd.port, "/event?directory=" + self.workdir)
        a.read_until(lambda fs: any(t == "server.connected" for _, _, t, _d in fs))
        pre_titles = ["pre%d" % i for i in range(3)]
        for title in pre_titles:
            e1.create_session(self.workdir, title)
            time.sleep(0.3)
        a.read_until(lambda fs: len([1 for _, _, t, _d in fs if t == "session.created"]) >= 3)
        # the driving engine's epoch: the one whose bus emitted the events
        epoch_votes = {}
        for f in a.events():
            epoch_votes[f[0].split(":", 1)[0]] = epoch_votes.get(f[0].split(":", 1)[0], 0) + 1
        e1_epoch = max(epoch_votes, key=lambda k: epoch_votes[k])
        live_events = a.events(epoch=e1_epoch)
        self.assertEqual(len(live_events), 3,
                         "the member saw the live events: %r" % (live_events,))
        # the member's cursor: the last event it applied (the panel's
        # vocabulary — the payload id, and the SSE id it rode on)
        cursor_pid = live_events[-1][1]
        cursor_sid = live_events[-1][0]
        # every engine id the member saw from the engine epoch is strictly
        # ordered and dupe-free on the EVENT frames (control frames —
        # connected, heartbeats — may repeat the current position by contract)
        live_eids = [int(s.split(":", 1)[1]) for s, _, t, _d in a.frames
                    if s and s.startswith(e1_epoch + ":") and t not in CONTROL_TYPES]
        self.assertEqual(live_eids, sorted(live_eids), "engine ids must be strictly ordered")
        self.assertEqual(len(live_eids), len(set(live_eids)), "no dupes on the live wire")

        # --- the kill: the member's link dies, THEN the middle hop dies ----
        a.close()
        self.fd.stop()          # the frontdoor's death takes the upstream links with it
        # the gap: real events land on the engine while every hop is down
        gap_titles = ["gap%d" % i for i in range(5)]
        for title in gap_titles:
            e1.create_session(self.workdir, title)
            time.sleep(0.2)
        self.fd.start()         # fresh frontdoor: its shared upstreams reconnect
        time.sleep(1.0)         # live-from-current — the gap is NOT in the new stream

        # --- the resume: the member's cursor through the door --------------
        a2 = Member(self.fd.port, "/event?directory=" + self.workdir,
                    cursor_query=cursor_pid)
        a2.read_until(lambda fs: len([1 for _, _, t, _d in fs
                                     if t == "session.created"]) >= 5, timeout=25)
        # EXACTLY the gap: the outage events, in order, each once, no dupes
        resumed = a2.events(epoch=e1_epoch)
        created = [f for f in resumed if f[2] == "session.created"]
        self.assertEqual(len(created), 5,
                         "the gap events arrive exactly: %r" % (resumed,))
        pids = [f[1] for f in created]
        self.assertEqual(len(pids), len(set(pids)), "no duped gap events")
        self.assertNotIn(cursor_pid, pids, "the pre-kill position must not re-serve")
        # the union stays clean: the other shard's arm answers the foreign
        # payload cursor with its own resolution (empty replay + live here)
        # — it must never inject event frames the member never saw
        foreign = [f for f in a2.events() if not f[0].startswith(e1_epoch + ":")]
        self.assertEqual(foreign, [],
                         "the non-owning shard contributed no event frames: %r" % (foreign,))
        # and mechanically: every EVENT id on the resumed wire is ordered,
        # unique, and strictly after the member's cursor (the connected frame
        # carries the resolved position itself — equal to the cursor — and
        # heartbeats may repeat the current position: control frames both)
        rseqs = [int(s.split(":", 1)[1]) for s, _, t, _d in a2.frames
                 if s and s.startswith(e1_epoch + ":") and t not in CONTROL_TYPES]
        self.assertEqual(rseqs, sorted(rseqs))
        self.assertEqual(len(rseqs), len(set(rseqs)))
        self.assertTrue(all(s > int(cursor_sid.split(":", 1)[1]) for s in rseqs),
                        "resumed EVENT ids must follow the cursor (cursor=%s): %r"
                        % (cursor_sid, rseqs[:5]))
        print("\nE2E observed: cursor=%s (payload %s) -> connected-at=%s, "
              "gap event seqs=%r, fresh-load identical"
              % (cursor_sid, cursor_pid,
                 next((s for s, _, t, _d in a2.frames
                       if t == "server.connected" and s), "?"), rseqs))

        # --- the fresh-load comparison -------------------------------------
        # a second member loading the SAME gap from the SAME cursor, via the
        # standard Last-Event-ID header (the native-EventSource carrier), on
        # a fresh connection: its transcript must EQUAL the resumed one.
        b = Member(self.fd.port, "/event?directory=" + self.workdir,
                   cursor_header=cursor_sid)
        # one more live event settles the comparison window (and proves the
        # resumed member keeps receiving live through the door)
        e1.create_session(self.workdir, "post")
        a2.read_until(lambda fs: len([1 for _, _, t, _d in fs
                                      if t == "session.created"]) >= 6, timeout=25)
        b.read_until(lambda fs: len([1 for _, _, t, _d in fs
                                     if t == "session.created"]) >= 6, timeout=25)
        # the header carrier carries the <epoch>:<seq> form — the native
        # EventSource vocabulary. The OTHER shard's arm cannot serve a
        # foreign EPOCH: its answer is the explicit reset frame, and it
        # must reach the member through the door (P1a's contract, live)
        self.assertTrue(any(t == "state.resync" for _, _, t, _d in b.frames),
                        "the foreign-epoch reset must reach the fresh-load member: %r"
                        % (b.frames[:8],))
        a2_events = a2.events(epoch=e1_epoch)
        b_events = b.events(epoch=e1_epoch)
        self.assertEqual([f[1] for f in a2_events], [f[1] for f in b_events],
                         "resumed transcript == fresh load (payload ids, in order)")
        self.assertEqual([f[0] for f in a2_events], [f[0] for f in b_events],
                         "resumed transcript == fresh load (engine ids, in order)")
        a2.close()
        b.close()

        # --- the steady state: the resumed member migrated to the fan-out --
        deadline = time.time() + 20
        while time.time() < deadline \
                and "migrated to shared fan-out" not in self.fd.log():
            time.sleep(0.5)
        self.assertIn("migrated to shared fan-out", self.fd.log(),
                      "the resumed member must return to the shared fan-out")
        # and after migration the member's stream keeps serving live frames
        tail = Member(self.fd.port, "/event?directory=" + self.workdir)
        e1.create_session(self.workdir, "post-migration")
        tail.read_until(lambda fs: any(t == "session.created" for _, _, t, _d in fs),
                        timeout=15)
        self.assertTrue(any(t == "session.created" for _, _, t, _d in tail.frames),
                        "the shared fan-out keeps serving after migration")
        tail.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
