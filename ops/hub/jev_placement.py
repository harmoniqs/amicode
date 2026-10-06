"""The Jev placement provider (amicode #1717 phase 1, slice 2).

Jev (TypeSafe System One) is the routing brain's ADVISORY layer: at session
admission it may decide which pool shard hosts a new session. Doctrine —
from arjev/src/arjev/jev.py, the contract of record (live-verified 2026-09-20,
amicode #1311): advisory-only, fail-open, never load-bearing. No key, outage,
or low confidence -> the deterministic least-loaded floor, unchanged, and the
receipt says why. Every call is a typed decision, logged as a receipt.

Wire: POST <AMICODE_JEV_URL>, {"model": "jev-latest", "state": <object>,
"questions": {"placement": {"type": "choice", "instructions": <str>,
"criteria": {shard: rubric}}}}; answer carries {"choice", "confidence",
"probabilities": {shard: p}}. Confidence = max probability (arjev's rule).

NEVER in the per-request hot path: place_with_jev() runs once per session at
admission, behind the frontdoor's place_session(), with a bounded timeout;
the deterministic floor answers while Jev thinks — and when Jev fails.

Receipts: JSONL at AMICODE_ROUTING_RECEIPTS (default
~/.amico/server/routing-receipts.jsonl), one line per ATTEMPTED call (enabled
+ key only — disabled/no-key placements write nothing). The schema is the
calibration dataset: join it later with per-shard wedge/RSS outcomes, the
arjev calibrate loop pointed at routing.
"""
import json
import os
import time
import urllib.request
from datetime import datetime, timezone

DEFAULT_URL = "https://api.typesafe.ai/v1/systemone"
DEFAULT_MODEL = "jev-latest"
DEFAULT_MIN_CONFIDENCE = 0.6
DEFAULT_TIMEOUT = 1.5     # admission carries a live user request; the floor answers while Jev thinks
STATE_CAP = 4096           # arjev's HARD_CAP doctrine

INSTRUCTIONS = (
    "Which pool shard should host this new engine session? "
    "Prefer the least-loaded member; when the load pattern suggests it, "
    "spread parallel sessions of the same directory across shards rather "
    "than piling them onto one."
)


def _env(key, default):
    v = os.environ.get(key)
    return v if v else default


def _flag(env_key):
    return _env(env_key, "").strip().lower() in ("1", "true", "yes", "on")


def _key():
    # same resolution as arjev: env key, then the EXPLICIT opt-in key file
    # (ARJEV_JEV_KEY_FILE); never reads any file without the env opt-in.
    k = os.environ.get("ARJEV_JEV_KEY")
    if k:
        return k
    path = os.environ.get("ARJEV_JEV_KEY_FILE")
    if path:
        try:
            k = open(os.path.expanduser(path)).read().strip()
            if k:
                return k
        except OSError:
            return None
    return None


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _answer_distribution(response):
    """arjev's _answer_distribution, specialized to the placement question:
    answers is a map keyed by id; a choice answer carries `probabilities`."""
    answer = (response.get("answers") or {}).get("placement")
    if not isinstance(answer, dict):
        return {}
    dist = answer.get("probabilities")
    if isinstance(dist, dict):
        return {str(k): float(v) for k, v in dist.items()}
    return {}


def _write_receipt(row):
    """Append one JSONL receipt. Never load-bearing: a write failure logs to
    stderr and the placement still returns."""
    path = _env("AMICODE_ROUTING_RECEIPTS",
                os.path.expanduser("~/.amico/server/routing-receipts.jsonl"))
    try:
        with open(path, "a") as f:
            f.write(json.dumps(row, sort_keys=True) + "\n")
    except Exception as e:
        print("jev-placement: receipt write failed: %s" % e, flush=True)


def place_with_jev(sid, directory, pool, loads, floor):
    """Decide the shard for a NEW session: Jev's advisory choice when it
    clears min_confidence and lands inside the pool; otherwise the
    deterministic floor. Returns (shard, mode, fail_reason, distribution).

    Never raises — every failure path fails open to the floor, with its
    fail_reason in the receipt: no-key | outage | low-confidence |
    state-overflow | error | disabled.
    """
    if not _flag("AMICODE_JEV_PLACEMENT"):
        return floor, "deterministic", "disabled", {}
    if os.environ.get("ARJEV_JEV_DISABLED", "").strip().lower() not in ("", "0", "false", "no", "off"):
        return floor, "deterministic", "disabled", {}
    if not _key():
        return floor, "deterministic", "no-key", {}
    started = time.monotonic()
    state = {
        "session": {"id": sid, "directory": directory},
        "pool": {str(i): {"in_flight_dials": loads.get(i, 0)} for i in pool},
        "policy": {"floor_shard": floor},
    }
    state_bytes = len(json.dumps({"state": state}, sort_keys=True).encode())
    if state_bytes > STATE_CAP:
        _write_receipt({"ts": _now(), "session_id": sid, "directory": directory,
                        "pool": pool, "loads": loads, "decision": floor, "mode": "deterministic",
                        "fail_reason": "state-overflow", "confidence": 0.0, "distribution": {},
                        "latency_ms": 0, "model_version": "none", "state_bytes": state_bytes})
        return floor, "deterministic", "state-overflow", {}
    url = _env("AMICODE_JEV_URL", DEFAULT_URL)
    timeout = float(_env("AMICODE_JEV_TIMEOUT", str(DEFAULT_TIMEOUT)))
    min_conf = float(_env("AMICODE_JEV_MIN_CONFIDENCE", str(DEFAULT_MIN_CONFIDENCE)))
    question = {
        "id": "placement",
        "type": "choice",
        "instructions": INSTRUCTIONS,
        "criteria": {str(i): "choose shard %d when its load is lowest and the "
                             "session best balances the pool there" % i for i in pool},
    }
    payload = json.dumps({"model": DEFAULT_MODEL, "state": state,
                           "questions": {"placement": question}}).encode()
    dist, model_version = {}, "none"
    fail_reason = None
    try:
        req = urllib.request.Request(url, data=payload, method="POST",
                                     headers={"authorization": "Bearer " + _key(),
                                              "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            dist = _answer_distribution(json.loads(r.read().decode("utf-8", "replace")))
            model_version = "jev"
    except Exception:
        fail_reason = "outage"
    latency_ms = int((time.monotonic() - started) * 1000)
    if fail_reason is None:
        if not dist:
            fail_reason = "error"
        else:
            confidence = max(dist.values())
            choice = max(dist, key=lambda k: dist[k])
            if confidence < min_conf:
                fail_reason = "low-confidence"
            elif int(choice) not in pool:
                fail_reason = "error"
            else:
                _write_receipt({"ts": _now(), "session_id": sid, "directory": directory,
                                "pool": pool, "loads": loads, "decision": int(choice), "mode": "jev",
                                "fail_reason": None, "confidence": confidence, "distribution": dist,
                                "latency_ms": latency_ms, "model_version": model_version,
                                "state_bytes": state_bytes})
                return int(choice), "jev", None, dist
    _write_receipt({"ts": _now(), "session_id": sid, "directory": directory,
                    "pool": pool, "loads": loads, "decision": floor, "mode": "deterministic",
                    "fail_reason": fail_reason or "error", "confidence": max(dist.values()) if dist else 0.0,
                    "distribution": dist, "latency_ms": latency_ms, "model_version": model_version,
                    "state_bytes": state_bytes})
    return floor, "deterministic", fail_reason or "error", dist