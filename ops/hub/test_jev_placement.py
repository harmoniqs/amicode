#!/usr/bin/env python3
"""test_jev_placement.py — unit suite for the Jev placement provider.

Fake systemone backends (http.server threads) drive the arjev wire contract:
{"answers": {"placement": {"choice", "confidence", "probabilities"}}}.

Run: python3 ops/hub/test_jev_placement.py   (exit 0 on pass)
"""
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jev_placement

POOL = [1, 2, 3]
LOADS = {1: 5, 2: 0, 3: 0}
FLOOR = 2   # loads 5,0,0 -> tie 2/3 -> lowest id


class FakeSystemone(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *a):
        pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        self.rfile.read(n)
        behavior = self.server.behavior
        if behavior.get("sleep"):
            time.sleep(behavior["sleep"])
        body = json.dumps(behavior.get("response", {})).encode()
        status = behavior.get("status", 200)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class _S(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class FakeAPI:
    def __init__(self, behavior):
        self.httpd = _S(("127.0.0.1", 0), FakeSystemone)
        self.httpd.behavior = behavior
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def confident_on(shard):
    return {"model": "jev-test", "answers": {"placement": {
        "type": "choice", "choice": str(shard), "confidence": 0.9,
        "probabilities": {str(shard): 0.9, "1": 0.05, "2": 0.05}}}}


class EnvMixin:
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="jev-place-test-")
        self.receipts = os.path.join(self.tmp, "receipts.jsonl")
        self.api = None
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        if self.api:
            self.api.stop()

    def env(self, **extra):
        # ARJEV_JEV_KEY_FILE pinned to a nonexistent path so the ambient hub
        # environment (which may carry a real key file) can't leak a key in
        e = {"AMICODE_JEV_PLACEMENT": "1", "ARJEV_JEV_KEY": "test-key",
             "ARJEV_JEV_KEY_FILE": "/nonexistent-jev-key",
             "AMICODE_ROUTING_RECEIPTS": self.receipts}
        e.update(extra)
        return mock.patch.dict(os.environ, e, clear=False)

    def api_env(self, behavior, **extra):
        self.api = FakeAPI(behavior)
        return self.env(AMICODE_JEV_URL="http://127.0.0.1:%d" % self.api.port, **extra)

    def receipts_lines(self):
        try:
            with open(self.receipts) as f:
                return [json.loads(x) for x in f.read().splitlines() if x.strip()]
        except FileNotFoundError:
            return []


class TestGating(EnvMixin, unittest.TestCase):
    def test_flag_off_is_disabled_no_receipt(self):
        with self.env(AMICODE_JEV_PLACEMENT="0"):
            shard, mode, fail, _ = jev_placement.place_with_jev("ses_a", "/d", POOL, LOADS, FLOOR)
        self.assertEqual((shard, mode, fail), (FLOOR, "deterministic", "disabled"))
        self.assertEqual(self.receipts_lines(), [])

    def test_no_key_fails_open(self):
        with self.env(ARJEV_JEV_KEY=""):
            shard, mode, fail, _ = jev_placement.place_with_jev("ses_a", "/d", POOL, LOADS, FLOOR)
        self.assertEqual((shard, mode, fail), (FLOOR, "deterministic", "no-key"))
        self.assertEqual(self.receipts_lines(), [])

    def test_kill_switch(self):
        with self.env(ARJEV_JEV_DISABLED="1"):
            shard, mode, fail, _ = jev_placement.place_with_jev("ses_a", "/d", POOL, LOADS, FLOOR)
        self.assertEqual((shard, mode, fail), (FLOOR, "deterministic", "disabled"))


class TestDecisions(EnvMixin, unittest.TestCase):
    def test_confident_choice_overrides_floor(self):
        with self.api_env({"response": confident_on(3)}):
            shard, mode, fail, dist = jev_placement.place_with_jev("ses_a", "/d", POOL, LOADS, FLOOR)
        self.assertEqual((shard, mode, fail), (3, "jev", None))
        rows = self.receipts_lines()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["mode"], "jev")
        self.assertEqual(rows[0]["decision"], 3)
        self.assertEqual(rows[0]["session_id"], "ses_a")
        self.assertGreaterEqual(rows[0]["confidence"], 0.9)
        self.assertIn("latency_ms", rows[0])

    def test_low_confidence_falls_to_floor(self):
        resp = {"model": "jev-test", "answers": {"placement": {
            "type": "choice", "choice": "3", "confidence": 0.4,
            "probabilities": {"3": 0.4, "1": 0.3, "2": 0.3}}}}
        with self.api_env({"response": resp}):
            shard, mode, fail, _ = jev_placement.place_with_jev("ses_a", "/d", POOL, LOADS, FLOOR)
        self.assertEqual((shard, mode, fail), (FLOOR, "deterministic", "low-confidence"))
        rows = self.receipts_lines()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["fail_reason"], "low-confidence")

    def test_timeout_is_outage_and_bounded(self):
        with self.api_env({"response": confident_on(3), "sleep": 3},
                          AMICODE_JEV_TIMEOUT="1.5"):
            t0 = time.monotonic()
            shard, mode, fail, _ = jev_placement.place_with_jev("ses_a", "/d", POOL, LOADS, FLOOR)
            elapsed = time.monotonic() - t0
        self.assertEqual((shard, mode, fail), (FLOOR, "deterministic", "outage"))
        self.assertLess(elapsed, 2.5, "the timeout must bound the admission latency")
        rows = self.receipts_lines()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["fail_reason"], "outage")

    def test_garbage_answer_is_error(self):
        with self.api_env({"response": {"model": "jev-test", "answers": {}}}):
            shard, mode, fail, _ = jev_placement.place_with_jev("ses_a", "/d", POOL, LOADS, FLOOR)
        self.assertEqual((shard, mode, fail), (FLOOR, "deterministic", "error"))

    def test_choice_outside_pool_is_error(self):
        with self.api_env({"response": confident_on(7)}):
            shard, mode, fail, _ = jev_placement.place_with_jev("ses_a", "/d", POOL, LOADS, FLOOR)
        self.assertEqual((shard, mode, fail), (FLOOR, "deterministic", "error"))
        rows = self.receipts_lines()
        self.assertEqual(rows[0]["fail_reason"], "error")

    def test_http_error_is_outage(self):
        with self.api_env({"response": {}, "status": 500}):
            shard, mode, fail, _ = jev_placement.place_with_jev("ses_a", "/d", POOL, LOADS, FLOOR)
        self.assertEqual((shard, mode, fail), (FLOOR, "deterministic", "outage"))

    def test_state_overflow_fails_open(self):
        huge = "x" * 5000
        with self.api_env(confident_on(3)):
            shard, mode, fail, _ = jev_placement.place_with_jev("ses_a", huge, POOL, LOADS, FLOOR)
        self.assertEqual((shard, mode, fail), (FLOOR, "deterministic", "state-overflow"))

    def test_never_raises_on_dead_url(self):
        # no fake API needed -- the URL itself is dead
        with self.env(AMICODE_JEV_URL="http://127.0.0.1:1/x"):
            shard, mode, fail, _ = jev_placement.place_with_jev("ses_a", "/d", POOL, LOADS, FLOOR)
        self.assertEqual((shard, mode, fail), (FLOOR, "deterministic", "outage"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
