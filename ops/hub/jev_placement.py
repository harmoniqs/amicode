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


# Slice 2b: the LOCAL weighted allocator. When no external Jev can answer
# (disabled / no-key / outage), placement does not have to fall to the
# tie-to-lowest-id floor: the frontdoor's sampler thread keeps a live
# busy-ness snapshot per shard (probe latency over the full request path,
# probe liveness, watchdog RSS) and the composite score turns it into a
# weighted choice. Weights, not winner-takes-all: a burst of admissions on
# equal-looking shards spreads probabilistically instead of piling onto the
# lowest id (the 2026-10-07 failure: 1274 pins, all on shard 1).
LOCAL_WEIGHTS = {"queue": 1.0, "probe": 3.0, "rss": 2.0}
LOCAL_PROBE_DEAD = 12.0
LOCAL_QUEUE_CAP = 50.0
LOCAL_PROBE_SLOW_MS = 500.0
LOCAL_RSS_RAIL_KB = 2621440.0

def _local_weighted_choice(pool, loads, samples):
    """Composite busy-ness -> weighted pick. Returns (shard, scores). Raises
    nothing the caller must catch; an empty pool raises (fail-open above)."""
    import random
    scores = {}
    for i in pool:
        # queue: dials + live groups + pinned sessions, capped -- the balance term
        s = LOCAL_WEIGHTS["queue"] * min(float(loads.get(i, 0)), LOCAL_QUEUE_CAP)
        snap = (samples or {}).get(i) or {}
        if snap.get("probe_ok"):
            s += LOCAL_WEIGHTS["probe"] * min((snap.get("probe_ms") or 0) / LOCAL_PROBE_SLOW_MS, 4.0)
        else:
            # dead or silent probe: the #775 wedge signature -- avoid hard
            # unless every member is equally dead (then the floor governs).
            s += LOCAL_PROBE_DEAD
        rss = snap.get("rss_kb")
        if rss:
            s += LOCAL_WEIGHTS["rss"] * min(float(rss) / LOCAL_RSS_RAIL_KB, 4.0)
        scores[i] = s
    alive = [i for i in pool if ((samples or {}).get(i) or {}).get("probe_ok")]
    candidates = alive if alive else list(pool)
    weights = {i: 1.0 / ((scores[i] + 1.0) ** 2) for i in candidates}
    total = sum(weights.values())
    r, acc = random.random() * total, 0.0
    for i in candidates:
        acc += weights[i]
        if r <= acc:
            return i, scores
    return candidates[-1], scores


def _local_mode_wanted():
    return _flag("AMICODE_JEV_LOCAL")


def _place_local(sid, directory, pool, loads, samples, floor, reason):
    """The local weighted choice, receipted. Any failure fails open to the
    floor with the fail_reason preserved."""
    try:
        shard, scores = _local_weighted_choice(pool, loads, samples)
        _write_receipt({"ts": _now(), "session_id": sid, "directory": directory,
                        "pool": pool, "loads": loads, "decision": shard, "mode": "jev-local",
                        "fail_reason": None, "samples": samples, "scores": scores,
                        "weights": LOCAL_WEIGHTS, "model_version": "jev-local", "superseded": reason})
        return shard, "jev-local", None, scores
    except Exception as e:
        print("jev-placement: local allocator failed: %s" % e, flush=True)
        return floor, "deterministic", reason, {}


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


def place_with_jev(sid, directory, pool, loads, floor, samples=None):
    """Decide the shard for a NEW session: Jev's advisory choice when it
    clears min_confidence and lands inside the pool; the LOCAL weighted
    allocator (slice 2b) when enabled and no external Jev answered; otherwise
    the deterministic floor. Returns (shard, mode, fail_reason, distribution).

    Never raises — every failure path fails open to the floor, with its
    fail_reason in the receipt: no-key | outage | low-confidence |
    state-overflow | error | disabled. samples is the frontdoor sampler's
    per-shard busy-ness snapshot (probe liveness/latency, watchdog RSS).
    """
    if not _flag("AMICODE_JEV_PLACEMENT"):
        if _local_mode_wanted():
            return _place_local(sid, directory, pool, loads, samples, floor, "disabled")
        return floor, "deterministic", "disabled", {}
    if os.environ.get("ARJEV_JEV_DISABLED", "").strip().lower() not in ("", "0", "false", "no", "off"):
        if _local_mode_wanted():
            return _place_local(sid, directory, pool, loads, samples, floor, "disabled")
        return floor, "deterministic", "disabled", {}
    if not _key():
        if _local_mode_wanted():
            return _place_local(sid, directory, pool, loads, samples, floor, "no-key")
        return floor, "deterministic", "no-key", {}
    started = time.monotonic()
    state = {
        "session": {"id": sid, "directory": directory},
        "pool": {str(i): {"in_flight_dials": loads.get(i, 0)} for i in pool},
        "busy": {str(i): (samples or {}).get(i) for i in pool},
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
        if _local_mode_wanted():
            return _place_local(sid, directory, pool, loads, samples, floor, "outage")
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