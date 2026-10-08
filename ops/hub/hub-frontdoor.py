import queue as _qmod
import socket, threading, time
import os as _os
import json as _json0
import re as _re1

def _env(key, default):
    v = _os.environ.get(key)
    return v if v else default

# 2026-10-04 (panel-stale-app incident): APP_DIST now points at the service's
# shelf dist (single source of truth, what amicode-server.sh gates + what deploys
# write). The old ~/.amico/server/app-dist copy shadowed every dist deploy since
# 2026-09-20 -- the fleet panel rode a stale app (missing pickers, composer
# "select agent and model" toast) while the canary sat one origin away.
APP_DIST = _env("AMICODE_APP_DIST", "/home/aaron/.amico/server/service/dist-app")
DEFAULT_BACKEND = ("127.0.0.1", 4095)
LOG = open(_env("AMICODE_FRONTDOOR_LOG", "/home/aaron/.amico/server/frontdoor.log"), "a", buffering=1)
_last_req = {}
def log(m): LOG.write(time.strftime("%H:%M:%S ") + m + "\n")

# --- #1717 phase 1: the shard pool ----------------------------------------------
# One engine process cannot carry the fleet: every session shares one JS event
# loop and one heap; under parallel load the loop saturates, the watchdog probe
# goes silent, and the restart kills EVERY session at once (9 kills on the
# 2026-10-04/05 night, all 29 active sessions in one directory). The pool shards
# the hot directory across N engines; this router is the switchboard. PLACEMENT
# IS ADMISSION-TIME ONLY: a session is placed once (first sight or creation) and
# sticky forever after -- engines hold process-local session state, in-flight
# sessions cannot migrate, and no request ever waits on a placement decision.
TABLE_PATH = _env("AMICODE_ROUTING_TABLE", _os.path.expanduser("~/.amico/server/routing.json"))
SESSION_MAP_PATH = _env("AMICODE_SESSION_MAP", _os.path.expanduser("~/.amico/server/routing-sessions.json"))
try:
    MAX_DIALS = int(_env("AMICODE_MAX_DIALS", "256"))
except ValueError:
    MAX_DIALS = 256

def _load_table():
    """The routing table. MISSING / unparseable / zero shards = LEGACY
    single-backend mode, byte-compatible with the pre-pool frontdoor -- the
    deploy-time rollback path AND the no-downtime rollout (the table ships
    absent, then grows shard by shard). A single-shard table adopts that
    shard as the backend."""
    try:
        with open(TABLE_PATH) as f:
            t = _json0.load(f)
        shards = t.get("shards") or []
        if not shards:
            return None
        backends = {}
        for s in shards:
            host, port = str(s["backend"]).rsplit(":", 1)
            backends[int(s["id"])] = (host, int(port))
        default = int(t.get("default_shard", next(iter(backends))))
        pools = {str(k): [int(x) for x in v]
                 for k, v in (t.get("directory_pools") or {}).items()}
        return {"backends": backends, "default_shard": default, "pools": pools}
    except Exception as e:
        log(f"routing table load failed ({e}) -- legacy single-backend mode")
        return None

TABLE = _load_table()
SHARDED = TABLE is not None and len(TABLE["backends"]) > 1
BACKEND = TABLE["backends"][TABLE["default_shard"]] if TABLE else DEFAULT_BACKEND

def _shard_backend(shard):
    if not SHARDED:
        return BACKEND
    return TABLE["backends"].get(shard, BACKEND)

# session stickiness: ses_<id> -> shard id, persisted write-through (tmp+rename)
_sess_map = {}
_sess_map_lock = threading.Lock()
if SHARDED:
    try:
        with open(SESSION_MAP_PATH) as f:
            _sess_map = {k: int(v) for k, v in _json0.load(f).items()}
    except Exception:
        _sess_map = {}

# Pin counts per shard — the placement floor's LONG-RUN balance signal.
# In-flight dials + live SSE groups are instantaneous, and admission happens
# at a quiet moment (dials ~0, groups not yet opened), so without pin counts
# every placement ties to the lowest shard id: 2026-10-07 production had the
# pool live with all 1274 pinned sessions on shard 1 and shards 2/3 idle —
# the wedge the pool was built to contain still killed every session at once.
_sess_count = {}
if SHARDED:
    for _s in _sess_map.values():
        _sess_count[_s] = _sess_count.get(_s, 0) + 1

def _pin(sid, shard):
    if not SHARDED:
        return
    with _sess_map_lock:
        prev = _sess_map.get(sid)
        if prev == shard:
            return
        if prev is not None:
            _sess_count[prev] = max(0, _sess_count.get(prev, 0) - 1)
        _sess_map[sid] = shard
        _sess_count[shard] = _sess_count.get(shard, 0) + 1
        try:
            tmp = SESSION_MAP_PATH + ".tmp"
            with open(tmp, "w") as f:
                _json0.dump(_sess_map, f)
            _os.replace(tmp, SESSION_MAP_PATH)
        except Exception as e:
            log(f"session map write failed: {e}")

# str pattern for the decoded request target (routing); bytes pattern for raw
# response sniffing — a str pattern raises TypeError on bytes, which the pipe's
# except would silently swallow (found the hard way, run 1 + run 2 of the suite).
_SES_RE = _re1.compile(r"ses_[A-Za-z0-9]+")
_SES_RE_B = _re1.compile(rb"ses_[A-Za-z0-9]+")

def _directory_of(raw):
    if "?" not in raw:
        return None
    try:
        import urllib.parse as _up
        for kv in raw.split("?", 1)[1].split("&"):
            if kv.startswith("directory="):
                return _up.unquote(kv[len("directory="):])
    except Exception:
        return None
    return None

# per-shard in-flight dial accounting: the placement load signal + the ceiling
_dial_lock = threading.Lock()
_dials_in_flight = 0
_dials_per_shard = {}

def _group_load(shard):
    n = 0
    with _groups_lock:
        for (s, _), g in GROUPS.items():
            if s == shard and g.upstream is not None:
                n += 1
    return n

# #1717 phase 1 slice 2: the optional Jev placement provider (advisory-only,
# fail-open -- the arjev doctrine; see jev_placement.py). Missing module or
# any failure -> the deterministic floor, which is the contract.
try:
    import jev_placement as _jev
except Exception:
    _jev = None

def place_session(sid, directory, raw):
    """Placement at session admission: the deterministic FLOOR is least
    (in-flight upstream dials + live SSE groups + pinned sessions), ties ->
    lowest shard id; the Jev provider (slice 2, advisory-only, fail-open) may
    override it for real sessions, and the floor is what Jev fails open TO."""
    pool = TABLE["pools"].get(directory) if directory else None
    if not pool:
        pool = [TABLE["default_shard"]]
    with _dial_lock:
        loads = {i: _dials_per_shard.get(i, 0) for i in pool}
    for i in pool:
        loads[i] += _group_load(i)
    with _sess_map_lock:
        for i in pool:
            loads[i] += _sess_count.get(i, 0)
    floor = min(pool, key=lambda i: (loads[i], i))
    # The Jev provider decides at SESSION admission only -- stateless directory
    # routes (sid None) never pay a model call.
    if sid is not None and _jev is not None:
        with _shard_samples_lock:
            samples = {i: dict(v) for i, v in _shard_samples.items() if i in pool}
        try:
            shard, mode, fail_reason, _dist = _jev.place_with_jev(sid, directory, pool, loads, floor, samples)
            log(f"placed {sid} -> shard {shard} (mode={mode}{' ' + (fail_reason or '') if fail_reason else ''})")
            return shard
        except Exception as e:
            log(f"jev placement failed ({e}) -- deterministic floor")
    return floor

def _route(raw):
    """Resolve the shard for a request target. Sticky for known sessions;
    placement (+pin) for unknown sessions on a pooled directory; stateless
    directory routes ride the least-loaded member; everything else -> default."""
    if not SHARDED:
        return 1
    m = _SES_RE.search(raw)
    sid = m.group(0) if m else None
    d = _directory_of(raw)
    pool = TABLE["pools"].get(d) if d else None
    if sid is not None:
        with _sess_map_lock:
            if sid in _sess_map:
                return _sess_map[sid]
        if pool:
            shard = pool[0] if len(pool) == 1 else place_session(sid, d, raw)
            _pin(sid, shard)
            return shard
        return TABLE["default_shard"]
    # 2026-10-07: question replies name a process-local request — route them
    # to the shard that posed the question (learned from question events).
    qm = _QUE_RE.search(raw)
    if qm is not None:
        with _QUESTION_LOCK:
            qshard = _QUESTION_SHARD.get(qm.group(0))
        if qshard is not None and qshard in TABLE["backends"]:
            return qshard
    if pool and len(pool) > 1:
        return place_session(None, d, raw)
    if pool:
        return pool[0]
    return TABLE["default_shard"]

_groups_lock = threading.Lock()

# #1717 slice 2b: live shard busy-ness sampling for Jev placement. NEVER in
# the per-request path: a daemon thread probes each shard's cheap route on an
# interval and tails the watchdog RSS trajectories; placement reads the last
# snapshot. The probe rides the same service+engine path real requests take,
# so probe_ms measures the latency a user would actually feel -- a wedging
# shard (the #775 signature: main loop saturated, HTTP silent) shows up as
# probe failure or latency long before the RSS rail is crossed.
_shard_samples = {}
_shard_samples_lock = threading.Lock()

def _watchdog_rss_kb(shard):
    """Last RSS the fleet watchdog recorded for a shard (5-min staleness is
    fine: it is a slow pressure signal, not an instantaneous one)."""
    try:
        name = "rss-trajectory.log" if shard == 1 else "rss-trajectory-shard%d.log" % shard
        path = _os.path.join(_env("AMICODE_WATCHDOG_DIR",
                                  _os.path.expanduser("~/.amico/server/fleet-watchdog")), name)
        with open(path) as f:
            for line in f:
                if "rss_kb=" in line:
                    rss = int(line.rsplit("rss_kb=", 1)[1].split()[0])
        return rss
    except Exception:
        return None

def _seed_question_map():
    """2026-10-07: recover the question->shard map for questions posed BEFORE
    a frontdoor restart (the event-learned map is in-memory). Each engine's
    /question list reports ITS OWN process-local pending questions — the
    answering shard IS the posing shard. Runs in the sampler loop, so a
    restart re-learns every still-pending question within one interval."""
    try:
        import urllib.parse as _upq
        for d, pool in TABLE["pools"].items():
            target = "/question?directory=" + _upq.quote(d, safe="")
            for shard in pool:
                b = backend_get(target, timeout=4, shard=shard)
                if not b:
                    continue
                try:
                    arr = _json0.loads(b)
                except Exception:
                    continue
                if not isinstance(arr, list):
                    continue
                with _QUESTION_LOCK:
                    for q in arr:
                        if isinstance(q, dict) and isinstance(q.get("id"), str) and q["id"].startswith("que_"):
                            _QUESTION_SHARD[q["id"]] = shard
                            if len(_QUESTION_SHARD) > _QUESTION_MAX:
                                _QUESTION_SHARD.pop(next(iter(_QUESTION_SHARD)))
    except Exception:
        pass

def _sample_shards():
    import urllib.parse as _up0
    import urllib.request as _ur0
    while True:
        if SHARDED:
            probe_dir = next(iter(TABLE["pools"]), "/home/aaron")
            snap = {}
            for shard, (host, port) in TABLE["backends"].items():
                t0 = time.monotonic()
                try:
                    req = _ur0.Request("http://%s:%d/config?directory=%s"
                                       % (host, port, _up0.quote(probe_dir, safe="")))
                    with _ur0.urlopen(req, timeout=2.0) as r:
                        r.read(1)
                    snap[shard] = {"probe_ok": True,
                                   "probe_ms": int((time.monotonic() - t0) * 1000)}
                except Exception:
                    snap[shard] = {"probe_ok": False, "probe_ms": None}
                snap[shard]["rss_kb"] = _watchdog_rss_kb(shard)
                snap[shard]["ts"] = time.time()
            with _shard_samples_lock:
                _shard_samples.update(snap)
            _seed_question_map()
        time.sleep(float(_env("AMICODE_SHARD_SAMPLE_INTERVAL", "5")))

if SHARDED:
    threading.Thread(target=_sample_shards, daemon=True).start()

def _get_group(shard, path):
    with _groups_lock:
        g = GROUPS.get((shard, path))
        if g is None:
            g = Group(path, shard, _shard_backend(shard))
            GROUPS[(shard, path)] = g
        return g

def _get_merged_group(path):
    with _groups_lock:
        g = GROUPS.get(("merged", path))
        if g is None:
            g = Group(path, TABLE["default_shard"], None, merge=dict(TABLE["backends"]))
            GROUPS[("merged", path)] = g
        return g

def _shed_503(c, retry_after=2):
    """Fast 503 -- never queue retries (queued retries amplify into storms; the
    client's own backoff governs). Retry-After 2 for dead-dial / ceiling cases:
    a dead shard refuses cheap, and a per-shard 503 is self-limiting. (The
    #1310 storm was against a busy-but-ALIVE backend where dials succeed -- that
    case still rides the existing slow-passthrough paths.) NO per-IP caps:
    fleet tunnels share addresses and would shed legitimate tabs; a client-aware
    shed is an open question, not silently guessed here."""
    try:
        c.sendall(("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n"
                   f"Retry-After: {retry_after}\r\n\r\n").encode())
    except Exception:
        pass
    c.close()

def _reload_table(signum, frame):
    global TABLE, SHARDED
    t = _load_table()
    if t is not None:
        TABLE = t
        SHARDED = len(t["backends"]) > 1
        log(f"routing table reloaded: {len(t['backends'])} shards, default {t['default_shard']}"
            " (existing SSE groups keep their upstreams until restart)")
    else:
        log("routing table reload FAILED -- keeping the live table")

try:
    import signal as _sig
    _sig.signal(_sig.SIGHUP, _reload_table)
except Exception:
    pass

if SHARDED:
    log(f"sharded mode: {len(TABLE['backends'])} shards, default {TABLE['default_shard']}, "
        f"{len(TABLE['pools'])} pooled dir(s), {len(_sess_map)} pinned session(s)")
else:
    log(f"legacy single-backend mode -> {BACKEND[0]}:{BACKEND[1]}")

# --- #1723: the UI-revert guard --------------------------------------------------
# Three incident classes shipped clients an OLD ui with no signal anywhere
# (#1283 cache self-assembly, the 2026-10-04 stale-dist panel, the vanished
# harness picker). The guard promotes the signals the logs already held into
# actions: a stale client's dead-asset request HEALS (one reload hop); a stale
# DIST crash-lands loudly instead of passing as a working panel; one route
# answers "what UI is live".
UI_FLOOR_PATH = _env("AMICODE_UI_FLOOR", _os.path.expanduser("~/.amico/server/ui-floor.json"))

def _ui_deploy_record():
    """The dist's deploy record — the freshness oracle. A missing record is
    itself a violation: every legitimate deploy since the live-test pattern
    started writes one."""
    try:
        with open(_os.path.join(APP_DIST, "deploy.json")) as f:
            d = _json0.load(f)
        return {"commit": str(d.get("commit", ""))[:12], "built_at": str(d.get("built_at", ""))}
    except Exception:
        return None

def _ui_floor():
    """No floor file = no enforcement (the guard arms by a deliberate ops
    act, never by default)."""
    try:
        with open(UI_FLOOR_PATH) as f:
            return _json0.load(f)
    except Exception:
        return None

def _ui_floor_ok():
    rec = _ui_deploy_record()
    if rec is None:
        return None, False
    floor = _ui_floor()
    if not floor:
        return rec, True
    min_at = str(floor.get("min_built_at", ""))
    if min_at and rec["built_at"] < min_at:
        return rec, False
    return rec, True

# The heal: a stale client asked for a content-hashed .js that no longer exists;
# answer VALID JS that reloads the no-cache index once. Bounded — the fresh
# index boots and requests only live assets; if the DIST is stale the floor
# crash-lands the very next hop.
_UI_HEAL_JS = b'location.replace("/?ui-heal=" + Date.now());'

def _crash_landing(rec):
    """#1723: the floor-violation interstitial. Fully self-contained (inline
    CSS/JS, no dist bytes) — it runs precisely when the dist is untrustworthy.
    Auto-reloads on a slow timer so a fixed deploy heals without intervention."""
    floor = _ui_floor() or {}
    live = f"{rec['commit']} ({rec['built_at']})" if rec else "MISSING deploy record"
    min_at = str(floor.get("min_built_at", "(unset)"))
    return ("""<!doctype html><html><head><meta charset="utf-8"><title>Amicode — UI freshness check failed</title>
<style>body{background:#111;color:#eee;font-family:ui-sans-serif,system-ui;margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
.c{max-width:640px;padding:2rem;border:1px solid #444;border-radius:10px;background:#181818}
h1{color:#f0b429;font-size:1.3rem;margin:0 0 .5rem}code{color:#f0b429}p{line-height:1.5;color:#bbb}
.refresh{color:#888;font-size:.85rem;margin-top:1rem}</style>
</head><body><div class="c"><h1>The panel UI failed its freshness check</h1>
<p>This is loud on purpose: the hub is serving a UI build <strong>older than the allowed floor</strong>,
and a stale panel must never pass as a working one.</p>
<p>Live UI build: <code>LIVE_BUILD</code><br>Allowed floor: <code>FLOOR_BUILD</code></p>
<p>This usually means a dist deploy was reverted or half-deployed. It heals itself when a
current dist lands — this page reloads every 15 seconds.</p>
<p class="refresh">amicode #1723 crash-landing</p></div>
<script>setTimeout(function(){location.reload()},15000)</script></body></html>"""
    ).replace("LIVE_BUILD", live).replace("FLOOR_BUILD", min_at).encode()

def _serve_bytes(c, body, ctype, extra_headers=""):
    hdr = ("HTTP/1.1 200 OK\r\nContent-Type: " + ctype + "\r\n"
           + extra_headers
           + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n")
    try:
        c.sendall(hdr.encode() + body)
    except Exception:
        pass
    c.close()

rec0, ok0 = _ui_floor_ok()
log("ui-build: %s, floor %s"
    % ((rec0["commit"] + " " + rec0["built_at"]) if rec0 else "NO DEPLOY RECORD",
       "ok" if ok0 else "VIOLATION"))

# --- #1311: UA census — the GET / storm (484 doc fetches / 2min observed) must
# be attributed to a client. Count requests by (path-class, User-Agent),
# report every 30s, clear.
_ua_counts = {}
_ua_lock = threading.Lock()
def ua_census(first, path):
    try:
        head = first.split(b"\r\n\r\n", 1)[0].decode("utf-8", "replace")
        ua = "-"
        for line in head.split("\r\n")[1:]:
            if line.lower().startswith("user-agent:"):
                ua = line.split(":", 1)[1].strip()[:90]
                break
        cls = "doc" if path == "/" else "sse" if path in ("/event", "/global/event") else "api"
        with _ua_lock:
            k = (cls, ua)
            _ua_counts[k] = _ua_counts.get(k, 0) + 1
    except Exception:
        pass
def _ua_report_loop():
    import time as _t
    while True:
        _t.sleep(30)
        with _ua_lock:
            if _ua_counts:
                items = sorted(_ua_counts.items(), key=lambda kv: -kv[1])[:8]
                log("ua-census " + " ; ".join(f"{cls} x{n} ua={ua}" for (cls, ua), n in items))
                _ua_counts.clear()
threading.Thread(target=_ua_report_loop, daemon=True).start()

# --- #1306: snapshot — the boot/switch state in ONE request ----------------------
_snap_lock = threading.Lock()
_snap_cache = {"t": 0.0, "body": None}
_SNAP_TTL = 15.0

# #1724: event-driven per-session message pages. The snapshot used to re-pull
# every top-N session's messages on every rebuild — cost proportional to
# DISPLAYED sessions (not active ones), all against the DEFAULT shard, and any
# event nuked the whole cache so churn re-pulled everything. Instead: the
# merged event frames mark the session they touch dirty, and rebuilds pull
# ONLY dirty pages (plus a slow TTL safety refresh). An idle hub performs
# zero message pulls.
_MSG_LOCK = threading.Lock()
_MSG_CACHE = {}      # sid -> (page, ts)
_MSG_DIRTY = set()
_MSG_TTL = float(_env("AMICODE_SNAPSHOT_MSG_TTL", "300"))
_MSG_CACHE_MAX = 200

def _dechunk(body):
    out = bytearray()
    i = 0
    while True:
        j = body.find(b"\r\n", i)
        if j < 0: return bytes(out) if out else body
        try: n = int(body[i:j].split(b";")[0].strip(), 16)
        except Exception: return body
        if n == 0: return bytes(out)
        out += body[j + 2: j + 2 + n]
        i = j + 2 + n + 2

def backend_get(target, timeout=60, shard=None):
    """One-shot localhost GET. Slow answers stream; only failures return None.

    2026-10-07: the read loop can NOT wait for EOF — the service app sends the
    body promptly but holds the socket ~6s after a Connection: close request
    (keep-alive wins), so every merged-list fetch paid the full hold and the
    5s merge deadline turned 'slow' into 'failed' (the 503s). Parse the
    framing instead: read Content-Length body bytes exactly, or the chunked
    terminator; EOF is only the fallback for neither being present."""
    b = _shard_backend(shard) if (SHARDED and shard is not None) else BACKEND
    try:
        s = socket.create_connection(b, timeout=8)
        s.settimeout(timeout)
        s.sendall(("GET " + target + f" HTTP/1.1\r\nHost: 127.0.0.1:{b[1]}\r\nConnection: close\r\nAccept-Encoding: identity\r\n\r\n").encode())
        buf = b""
        want = None     # exact body length from Content-Length, once headers land
        chunked = False
        while True:
            if want is not None and len(buf) >= want:
                break
            d = s.recv(262144)
            if not d:
                break
            buf += d
            if want is None and b"\r\n\r\n" in buf:
                i0 = buf.find(b"\r\n\r\n")
                head0 = buf[:i0]
                if b"transfer-encoding: chunked" in head0.lower():
                    chunked = True
                    if b"0\r\n\r\n" in buf:
                        break
                else:
                    for line in head0.split(b"\r\n"):
                        if line.lower().startswith(b"content-length:"):
                            want = int(line.split(b":", 1)[1].strip()) + i0 + 4
                            break
                    if want is None and not chunked:
                        break   # no framing at all: bodyless/no-content response
        s.close()
    except Exception:
        return None
    i = buf.find(b"\r\n\r\n")
    if i < 0: return None
    head, body = buf[:i], buf[i + 4:]
    if b" 200 " not in head.split(b"\r\n", 1)[0]: return None
    if b"transfer-encoding: chunked" in head.lower(): body = _dechunk(body)
    if b"content-encoding: gzip" in head.lower():
        import gzip as _g
        try: body = _g.decompress(body)
        except Exception: return None
    return body

_TRIM_LIMIT = 4096
_TRIM_KEEP = 2048

def _trim(obj):
    """#1306: huge tool-output strings would make the snapshot weigh megabytes
    (one running session's 20-message page was 7.3MB raw). Keep the head of
    oversized strings; the app paints from the trimmed page immediately and
    its background wire-reconcile replaces trimmed pages with full text."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            out[k] = _trim(v)
        return out
    if isinstance(obj, list):
        return [_trim(x) for x in obj]
    if isinstance(obj, str) and len(obj) > _TRIM_LIMIT:
        return obj[:_TRIM_KEEP] + "\u2026[__trimmed]"
    return obj

def _merge_session_lists(lists):
    """#1717 phase 1: merge shard session lists. Envelope: BARE array (the
    engine's GET /session answers Schema.Array(Session.Info), verified against
    packages/opencode/src/server/routes/instance/httpapi/groups/session.ts).
    Dedupe by id -- defensive: stickiness prevents cross-shard dupes, and with
    the shared DB every shard's list is a superset until Phase 2 partitions DBs.
    Order: time.updated desc."""
    seen = {}
    for lst in lists:
        if isinstance(lst, dict):
            lst = lst.get("sessions") or lst.get("data") or []
        if not isinstance(lst, list):
            continue
        for s in lst:
            if isinstance(s, dict) and s.get("id") and s["id"] not in seen:
                seen[s["id"]] = s
    def _u(s):
        t = s.get("time") or {}
        u = t.get("updated")
        return u if isinstance(u, (int, float)) else 0
    return sorted(seen.values(), key=lambda s: -_u(s))

def _merged_session_list():
    """The hub-wide session list: every shard in sharded mode, one backend_get
    in legacy mode. Parallel fan-out under the same merge deadline as the
    pooled-directory list — a dead or wedged member contributes nothing and
    delays nothing (the sequential version serially paid every dead shard's
    full timeout)."""
    if not SHARDED:
        return backend_get("/session?limit=100")
    deadline = float(_env("AMICODE_MERGE_DEADLINE", "5"))
    results = {}
    threads = []

    def fetch(shard):
        try:
            b = backend_get("/session?limit=100", timeout=deadline, shard=shard)
            if b:
                results[shard] = b
        except Exception:
            pass

    for shard in TABLE["backends"]:
        t = threading.Thread(target=fetch, args=(shard,), daemon=True)
        t.start(); threads.append(t)
    for t in threads:
        t.join(deadline + 1.0)
    lists = []
    for b in results.values():
        try:
            lists.append(_json0.loads(b))
        except Exception:
            pass
    if not lists:
        return None
    return _json0.dumps(_merge_session_lists(lists)).encode()

def build_snapshot(top):
    import json as _json
    health = backend_get("/global/health")
    if health is None: return None
    lst = _merged_session_list()   # same cap the frontdoor enforces on client lists
    if lst is None: return None
    try: sessions = _json.loads(lst)
    except Exception: return None
    if isinstance(sessions, dict):
        sessions = sessions.get("sessions") or sessions.get("data") or []
    messages = {}
    trimmed = set()
    def pull(sid):
        # #1724: shard-aware — the session's OWNING shard serves the pull
        # (the shared DB makes the default shard *work*, which is why months
        # of display load silently piled onto shard 1), cached + dirty-marked
        # (idle rebuilds re-pull nothing).
        with _sess_map_lock:
            shard = _sess_map.get(sid)
        with _MSG_LOCK:
            cached = _MSG_CACHE.get(sid)
            dirty = sid in _MSG_DIRTY
        if cached is not None and not dirty and time.time() - cached[1] < _MSG_TTL:
            messages[sid] = cached[0]
            return
        b = backend_get("/session/" + sid + "/message?limit=20", shard=shard)
        if b:
            try:
                page = _json.loads(b)
            except Exception:
                if cached is not None:
                    messages[sid] = cached[0]
                return
            raw = len(b)
            page = _trim(page)
            if len(_json.dumps(page)) < raw - 64:   # something was actually trimmed
                trimmed.add(sid)
            messages[sid] = page
            with _MSG_LOCK:
                _MSG_DIRTY.discard(sid)
                if len(_MSG_CACHE) >= _MSG_CACHE_MAX and sid not in _MSG_CACHE:
                    _MSG_CACHE.pop(next(iter(_MSG_CACHE)))
                _MSG_CACHE[sid] = (page, time.time())
        elif cached is not None:
            # stale beats empty: a failed pull degrades to the cached page
            messages[sid] = cached[0]
    ids = [s.get("id") for s in sessions if isinstance(s, dict) and s.get("id")][:top]
    ths = [threading.Thread(target=pull, args=(i,)) for i in ids]
    for t in ths: t.start()
    for t in ths: t.join()
    last_eid = None
    try:
        # slice 1c: the /global/event history lives in the MERGED group's
        # shared ring in sharded mode (the union is the stream of record).
        # #1724: GET the group, not just .get() — creating it starts the
        # upstream loops whose frames dirty-mark message pages, so the
        # snapshot is event-driven even with no tab holding the stream.
        if SHARDED:
            g = _get_merged_group("/global/event")
        else:
            g = _get_group(1, "/global/event")
        if g:
            with g.lock:
                if g.history: last_eid = g.history[-1][0]
    except Exception: pass
    snap = {"snapshot": 1, "ts": time.time(),
            "health": _json.loads(health), "sessions": sessions, "messages": messages,
            "trimmed": sorted(trimmed)}
    if last_eid: snap["lastEventID"] = last_eid
    return _json.dumps(snap).encode()

def snapshot_invalidate():
    with _snap_lock: _snap_cache["body"] = None

def mark_session_dirty(frame):
    """#1724: an event frame names the session it changed — dirty-mark that
    session's message page instead of forcing every page to be re-pulled."""
    m = _SES_RE_B.search(frame)
    if m is None:
        return
    try:
        sid = m.group(0).decode("ascii")
    except Exception:
        return
    with _MSG_LOCK:
        _MSG_DIRTY.add(sid)

# 2026-10-07: pending questions are PROCESS-LOCAL engine state — the reply
# must reach the SAME shard that posed the question, or the engine answers
# "question request not found" (the wire POST /question/que_X/reply carries no
# session id and no directory, so it fell to the default shard the moment
# sessions moved off it). The question events riding the merged streams
# carry the mapping: a question.v2.asked frame ARRIVED from the posing
# shard's upstream, so the frame + the upstream's shard id ARE the map.
_QUE_RE = _re1.compile(r"que_[A-Za-z0-9]+")
_QUE_RE_B = _re1.compile(rb"que_[A-Za-z0-9]+")
_QUESTION_LOCK = threading.Lock()
_QUESTION_SHARD = {}    # que_id -> shard that posed it
_QUESTION_MAX = 500

def note_question_frame(frame, shard_id):
    if b"question.v2" not in frame:
        return
    m = _QUE_RE_B.search(frame)
    if m is None:
        return
    try:
        qid = m.group(0).decode("ascii")
    except Exception:
        return
    with _QUESTION_LOCK:
        if b"question.v2.replied" in frame or b"question.v2.rejected" in frame:
            _QUESTION_SHARD.pop(qid, None)
        else:
            _QUESTION_SHARD[qid] = shard_id
            if len(_QUESTION_SHARD) > _QUESTION_MAX:
                _QUESTION_SHARD.pop(next(iter(_QUESTION_SHARD)))

def serve_snapshot(c, first, raw):
    qs = raw.split("?", 1)[1] if "?" in raw else ""
    top = 30
    for kv in qs.split("&"):
        if kv.startswith("top="):
            try: top = max(1, min(int(kv[4:]), 100))
            except Exception: pass
    body = None
    with _snap_lock:
        if _snap_cache["body"] is not None and time.time() - _snap_cache["t"] < _SNAP_TTL:
            body = _snap_cache["body"]
    fresh = False
    if body is None:
        body = build_snapshot(top)
        fresh = True
        if body is not None:
            with _snap_lock:
                _snap_cache["t"] = time.time(); _snap_cache["body"] = body
    if body is None:
        try: c.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 10\r\nConnection: close\r\n\r\n")
        except Exception: pass
        c.close(); return
    want_gz = b"gzip" in first.split(b"\r\n\r\n", 1)[0].lower()
    import gzip as _g
    payload = _g.compress(body, 6) if want_gz else body
    hdr = ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
           f"Content-Length: {len(payload)}\r\nX-Snapshot-Fresh: {1 if fresh else 0}\r\n")
    if want_gz: hdr += "Content-Encoding: gzip\r\n"
    hdr += "Connection: close\r\n\r\n"
    try:
        c.sendall(hdr.encode() + payload)
    except Exception: pass
    c.close()

def serve_file(c, fpath, ctype, cache=None):
    try:
        body = open(fpath, "rb").read()
    except OSError as e:
        log("app-dist missing %s (%s)" % (fpath, e))
        return False
    headers = "HTTP/1.1 200 OK\r\nContent-Type: " + ctype + "\r\n"
    if cache:
        headers += "Cache-Control: " + cache + "\r\n"
    headers += "Content-Length: %d\r\nConnection: close\r\n\r\n" % len(body)
    try:
        c.sendall(headers.encode() + body)
    except Exception:
        pass
    c.close()
    return True

def app_dist_serve(c, path):
    # 2026-09-19: serve the app dist from the frontdoor (amicode#1283 made
    # real) — app fixes ship WITHOUT binary rebuilds. Hashed assets are
    # immutable; the index is no-cache so dist swaps propagate immediately.
    import os.path as _p
    if path == "/":
        # #1723: the floor check gates every index serve (both origins, plus
        # the SPA-INDEX document fallbacks below) — a dist older than the
        # floor crash-lands loudly; a fresh dist serves as today, with its
        # build stamped on the response.
        rec, ok = _ui_floor_ok()
        if not ok:
            log(f"UI-REVERT caught: floor violation at index serve — crash-landing (live={rec})")
            _serve_bytes(c, _crash_landing(rec), "text/html; charset=utf-8")
            return True
        try:
            body = open(_p.join(APP_DIST, "index.html"), "rb").read()
        except OSError as e:
            log("app-dist missing index.html (%s) - 503" % e)
            return False
        _serve_bytes(c, body, "text/html; charset=utf-8",
                     extra_headers=("Cache-Control: no-cache\r\n"
                                    + ("X-UI-Build: %s\r\n" % rec["commit"] if rec else "")))
        return True
    if path.startswith("/assets/"):
        rel = path[len("/assets/"):]
        if ".." in rel or rel.startswith("/"):
            return False
        f = _p.join(APP_DIST, "assets", rel)
        if _p.isfile(f):
            ctype = ("text/javascript; charset=utf-8" if f.endswith(".js")
                     else "text/css; charset=utf-8" if f.endswith(".css")
                     else "font/woff2" if f.endswith(".woff2")
                     else "image/png" if f.endswith(".png") else "application/octet-stream")
            return serve_file(c, f, ctype, "public, max-age=31536000, immutable")
    return False

# 2026-09-15 fan-out freeze: a member that stops draining (slept client,
# black-holed tunnel TCP) must be DISCONNECTED, never allowed to block the
# shared fan-out. Before this, the recv loop's m.sendall(chunk) blocked on
# the first stalled member — freezing SSE for EVERY member fleet-wide.
MEMBER_QUEUE_MAX_ITEMS = 64   # ≈4MB at 64KB chunks; beyond this the member is stalled

# --- #1264 lossless SSE reconnect: the frontdoor reassembles upstream
# bytes into complete SSE frames, keeps a bounded ring of them keyed by
# the event id in the payload, and replays the gap after a client's
# lastEventID on reconnect. A tunnel blip no longer drops events.
HISTORY_MAX = 512
REPLAY_CAP = 64   # unknown-id replay: bounded slice, never the full ring

def _frame_id(frame):
    i = frame.find(b'"id":"')
    if i < 0: return None
    j = frame.find(b'"', i + 6)
    return frame[i + 6:j].decode("utf-8", "replace") if j > 0 else None

def _parse_frames(buf):
    """Split a byte stream on complete SSE frames. The opencode backend
    emits LF-LF framing (verified on the wire: 0x0a0a, not CRLFCRLF);
    accept either so a framing change can't silently kill the fan-out.
    Returns (frames, remainder) — frames keep their separators
    byte-exact."""
    out = []
    while True:
        i = buf.find(b"\n\n")
        j = buf.find(b"\r\n\r\n")
        cands = [k for k in (i, j) if k >= 0]
        if not cands: break
        k = min(cands)
        end = k + 4 if k == j and j != i else k + 2
        out.append(buf[:end])
        buf = buf[end:]
    return out, buf

class Group:
    def __init__(self, path, shard=1, backend=None, merge=None):
        self.path = path
        # #1717 phase 1: a group owns exactly one (shard, path) upstream --
        # session-scoped streams join the OWNING shard's group, global ones
        # the default shard's.
        # #1717 phase 1 slice 1c (MERGED groups): the real /event stream is
        # DIRECTORY-scoped and session-less on the wire (WorkspaceRoutingQuery
        # -- no session param), so a client's live stream must carry frames
        # from EVERY pool member or off-default sessions stream to nobody.
        # merge = {shard_id: backend_addr}: one upstream thread per member,
        # fanning the UNION into one shared history + member queues; the first
        # upstream to connect provides the join preamble (any one head is a
        # valid head). Event ids stay unique across shards via the shared DB's
        # event_sequence.
        self.shard = shard
        self.backend = backend if backend else BACKEND
        self.merge = merge
        self.live_upstreams = 0
        self.lock = threading.Lock()
        self.members = {}    # member socket -> outbound queue.Queue
        self.preamble = b""
        self.upstream = None
        self.history = []   # [(event_id, frame_bytes)] — bounded ring
        if merge:
            for _sid, _addr in merge.items():
                threading.Thread(target=self.upstream_loop, args=(_sid, _addr), daemon=True).start()
        else:
            threading.Thread(target=self.upstream_loop, args=(shard, self.backend), daemon=True).start()
    def build_preamble(self, addr):
        req = f"GET {self.path} HTTP/1.1\r\nHost: 127.0.0.1:{addr[1]}\r\nAccept: text/event-stream\r\n\r\n".encode()
        s = socket.create_connection(addr)
        s.sendall(req)
        buf = b""
        s.settimeout(60)
        # The server emits CRLF SSE frames — stop at the first server.connected
        # frame; any partial trailing bytes complete naturally from the live stream.
        while b"server.connected" not in buf:
            chunk = s.recv(65536)
            if not chunk: raise RuntimeError("upstream closed during preamble")
            buf += chunk
            if len(buf) > 262144: raise RuntimeError("preamble too large")
        s.settimeout(None)
        return s, buf
    def _drop(self, c):
        with self.lock: self.members.pop(c, None)
        try: c.close()
        except Exception: pass
    def _writer(self, c, q):
        """Per-member outbound writer — the ONLY thread that sends on the
        member socket (ordering = queue order). Exits on the first send
        failure; the member is then dropped."""
        try:
            while True:
                chunk = q.get()
                if chunk is None: break
                c.sendall(chunk)
        except Exception: pass
        self._drop(c)
    def upstream_loop(self, shard_id, addr):
        # reasm is per-upstream (each stream has its own partial tail); history
        # + member fan-out are shared under self.lock.
        backoff = 0.5
        while True:
            try:
                s, pre = self.build_preamble(addr)
            except Exception as e:
                log(f"[{self.path}/s{shard_id}] upstream down ({e}); retry in {backoff}s")
                time.sleep(backoff); backoff = min(backoff * 2, 5); continue
            backoff = 0.5
            reasm = b""
            frames, reasm = _parse_frames(pre)
            with self.lock:
                if self.upstream is None:
                    # first live upstream: the preamble provider for joins
                    self.upstream = s
                    self.preamble = pre
                    self.history = []   # history spans the (new) live stream
                self.live_upstreams += 1
                n_waiting = len(self.members)
            log(f"[{self.path}/s{shard_id}] upstream live ({n_waiting} waiting members)")
            try:
                while True:
                    chunk = s.recv(65536)
                    if not chunk: break
                    reasm += chunk
                    frames, reasm = _parse_frames(reasm)
                    for frame in frames:
                        # #1306: state changed — the snapshot cache must not
                        # outlive the events that changed it. #1724: the body
                        # still drops for immediate freshness, but only the
                        # session the frame NAMES is dirty-marked — the
                        # rebuild re-pulls that one page, not all of them.
                        try:
                            if b'"message.' in frame or b'"session.' in frame or b'"server.' in frame:
                                if b'"server.heartbeat' not in frame:
                                    snapshot_invalidate()
                                    mark_session_dirty(frame)
                            note_question_frame(frame, shard_id)
                        except Exception: pass
                    with self.lock:
                        for frame in frames:
                            eid = _frame_id(frame)
                            if eid is not None:
                                self.history.append((eid, frame))
                                if len(self.history) > HISTORY_MAX:
                                    del self.history[: len(self.history) - HISTORY_MAX]
                        for m, q in list(self.members.items()):
                            if q.qsize() >= MEMBER_QUEUE_MAX_ITEMS:
                                # Stalled member: disconnect it (the app's reconnect
                                # heals it with a fresh stream) — never block here.
                                # NOTE: leave() also takes the lock — inline it.
                                self.members.pop(m, None)
                                q.put(None)
                                try: m.close()
                                except: pass
                                log(f"[{self.path}/s{shard_id}] member dropped — stalled (queue full)")
                                continue
                            for frame in frames:
                                q.put(frame)
            except Exception: pass
            try: s.close()
            except: pass
            with self.lock:
                self.live_upstreams -= 1
                was_preamble = s is self.upstream
                if was_preamble:
                    self.upstream = None
                all_down = self.live_upstreams == 0
                members = list(self.members) if all_down else []
            if was_preamble:
                # a rejoining upstream (this one or a sibling) re-seeds the preamble
                log(f"[{self.path}/s{shard_id}] preamble upstream lost; joins wait for a re-seed")
            if all_down:
                # every upstream is gone: close the members (the app's reconnect
                # heals with fresh streams) — the pre-pool behavior, now scoped to
                # the whole pool being down.
                for m in members:
                    self.leave(m)
                    try: m.close()
                    except: pass
                log(f"[{self.path}/s{shard_id}] all upstreams lost; closed {len(members)} members")
    def join(self, c, last_event_id=None):
        with self.lock:
            if c in self.members: return
            q = _qmod.Queue()
            self.members[c] = q
        threading.Thread(target=self._writer, args=(c, q), daemon=True).start()
        while True:
            with self.lock:
                if self.upstream is not None:
                    if self.members.get(c) is not q: return   # dropped while waiting
                    # #1264 (both fresh and replay connects): enqueue only
                    # the preamble's COMPLETE frames. The frame-based fan-out
                    # broke the original "partial tail completes from the
                    # live stream" contract — the tail's completion arrives
                    # as an already-parsed COMPLETE frame, so a member that
                    # got the raw preamble received duplicated/corrupted
                    # bytes at the seam and its SSE parse broke (~10s
                    # reconnect cycle). Dropping the tail loses nothing: the
                    # first parsed frame contains that content.
                    pre_frames, _partial = _parse_frames(self.preamble)
                    for frame in pre_frames:
                        if q.qsize() < MEMBER_QUEUE_MAX_ITEMS:
                            q.put(frame)
                    if last_event_id is None:
                        return
                    # #1264 replay connect: the gap after the cursor.
                    if self.history:
                        index = None
                        for i, (eid, _) in enumerate(self.history):
                            if eid == last_event_id:
                                index = i
                                break
                        if index is not None:
                            # #1307: cap gap-replays TOO. A fresh document
                            # inherits its predecessor's cursor (sessionStorage)
                            # — with a running session that gap was ~7 minutes
                            # = 512 frames. The full-gap replay flooded the
                            # client, the reader choked, and it reconnected
                            # with the SAME cursor → a permanent 512-frame
                            # flood loop (~8s of churn every few seconds, the
                            # noise floor under every switch). The reducers are
                            # idempotent and the snapshot seeds state — the
                            # most recent frames suffice, and the cursor
                            # advances out of the loop.
                            replay = self.history[max(index + 1, len(self.history) - REPLAY_CAP):]
                        else:
                            # Unknown id (evicted / restart): the most
                            # recent REPLAY_CAP frames — the full 512-frame
                            # ring flooded the member queue and fed the
                            # storm; the reducers are idempotent and
                            # reconcile, so a bounded over-delivery heals.
                            replay = self.history[-REPLAY_CAP:]
                        for _, frame in replay:
                            if q.qsize() < MEMBER_QUEUE_MAX_ITEMS:
                                q.put(frame)
                        if replay:
                            log(f"[{self.path}] replayed {len(replay)} frames after {last_event_id[:24]}{' (unknown id, capped)' if index is None else ''}")
                    return
            time.sleep(0.3)

    def leave(self, c):
        with self.lock: q = self.members.pop(c, None)
        if q is not None:
            q.put(None)

# #1717 phase 1: groups are (shard, path) -- one upstream per shard -- except
# the client-facing event paths in sharded mode, which are MERGED under the
# ("merged", path) key: one upstream thread per pool member fanning the union
# into one shared history + member queues (slice 1c -- the wire /event is
# directory-scoped and session-less, so only a merged stream carries
# off-default sessions' frames). Legacy mode pre-creates exactly the two warm
# single-upstream groups the pre-pool frontdoor had.
GROUPS = {}
_default_shard_id = TABLE["default_shard"] if SHARDED else 1
for _p in ("/event", "/global/event"):
    if SHARDED:
        GROUPS[("merged", _p)] = Group(_p, _default_shard_id, None, merge=dict(TABLE["backends"]))
    else:
        GROUPS[(_default_shard_id, _p)] = Group(_p, _default_shard_id, _shard_backend(_default_shard_id))

# --- GET response cache: poll floods must not become backend connection floods ----
CACHE_TTL = 5.0
CACHE_MAX = 2097152          # 2 MB — the SPA index and capped session lists must fit
INDEX_TTL = 60.0             # the SPA index is stable; serve it stale for a minute
cache_lock = threading.Lock()
cache = {}
index_refresh = threading.Lock()   # single-flight for the "/" refresh

def cache_get(key, ttl=None):
    with cache_lock:
        e = cache.get(key)
        if e and time.time() - e[0] < (ttl if ttl is not None else CACHE_TTL):
            return e[1]
    return None

def refresh_index():
    """Fetch the SPA index from the backend with curl (handles keep-alive/chunked
    that defeat the streaming capture) and cache a complete HTTP/1.1 response."""
    try:
        import subprocess
        r = subprocess.run(["curl", "-s", "-m", "5", f"http://{BACKEND[0]}:{BACKEND[1]}/"],
                           capture_output=True, timeout=8)
        if r.returncode == 0 and r.stdout:
            # 2026-09-19 cache bust: fleet webviews hold hashed JS assets as
            # immutable — a patched asset under the SAME url never re-fetches.
            # Version the script srcs so clients fetch fresh (patched) bytes.
            import re as _re
            body = _re.sub(rb'(src="/assets/[^"]+\.js)', rb'\1?v=veilfix2', r.stdout)
            resp = (b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                    + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                    + body)
            with cache_lock:
                cache["/?index"] = (time.time(), resp)
            log("index cache refreshed (%d bytes)" % len(body))
    except Exception as e:
        log(f"index refresh failed: {e}")
    finally:
        try: index_refresh.release()
        except Exception: pass

def passthrough_capture(c, first_chunk, key=None, force_close=False, shard=None, pin_create=None):
    """Passthrough; capture small fast 200 GET responses for the cache.
    #1717 phase 1: dials the ROUTED shard (default when unrouted); admits to
    the global dial ceiling (MAX_DIALS -- storms must shed, not pile); on a
    dead shard answers a fast 503 (the rest of the pool is untouched); with
    pin_create, sniffs a POST /session response for the server-created id and
    pins it to the serving shard."""
    global _dials_in_flight
    bid = id(c) % 10000
    backend = _shard_backend(shard) if (SHARDED and shard is not None) else BACKEND
    with _dial_lock:
        if _dials_in_flight >= MAX_DIALS:
            _shed_503(c)
            return
        _dials_in_flight += 1
        if SHARDED and shard is not None:
            _dials_per_shard[shard] = _dials_per_shard.get(shard, 0) + 1
    try:
        try: u = socket.create_connection(backend, timeout=8)
        except Exception as e:
            log(f"upstream fail (shard {shard}): {e}")
            # dead shard: fast 503 (Retry-After 2 -- a dead shard refuses
            # cheap; the pre-pool #1310 Retry-After 10 guarded a BUSY backend
            # where dials SUCCEED and retries pile, a different failure mode).
            _shed_503(c)
            return
        # #1310: create_connection(timeout=8) LEAVES an 8s recv timeout on the
        # socket — any backend response slower than 8s was KILLED mid-stream
        # (the +3.1s-to-8s wire fetches, the connection-death retry patterns
        # while sessions ran). Slow must mean SLOW, never DEAD.
        u.settimeout(90)
        if force_close and first_chunk.endswith(b"\r\n\r\n"):
            # keep-alive upstreams never close → capture never completes → cache never fills.
            # HTTP honors the last Connection header, so appending wins.
            first_chunk = first_chunk[:-2] + b"Connection: close\r\n\r\n"
        log(f"be+{bid} opened")
        done = threading.Event()
        cap = {"buf": bytearray(), "ok": False}
        _sniffed = [False]
        _pinned = [False]
        cap_flag = key is not None or pin_create is not None
        def pipe(src, dst, capture=False, sniff=False):
            try:
                while True:
                    d = src.recv(65536)
                    if not d: break
                    if sniff and not _sniffed[0]:
                        _sniffed[0] = True
                        try:
                            if b"content-type: text/html" in d[:1024].lower():
                                log(f"HTML-RESPONSE for: {_last_req.get(cid, '?')[:130]}")
                                # #1457: HTML crossing the tunnel must NEVER be
                                # cacheable — a 200 text/html response is cacheable
                                # by default, and a cached HTML body for a data or
                                # chunk URL poisons it client-side forever (the
                                # "Failed to fetch dynamically imported module" and
                                # "Unexpected token '<'" classes). Stamp no-store.
                                d = _no_store_html(d)
                        except Exception: pass
                    if capture:
                        if len(cap["buf"]) + len(d) <= CACHE_MAX + 65536:
                            cap["buf"] += d
                        else:
                            cap["ok"] = False; cap["buf"] = bytearray()
                        # #1717 phase 1 create-sniff: pin the server-created id
                        # the MOMENT its bytes flow through the pipe — the
                        # client's very next request (the follow-up to the id it
                        # just learned) must already stick to the creating
                        # shard. Pinning after the pipes close loses that race.
                        if pin_create is not None and not _pinned[0]:
                            m = _SES_RE_B.search(bytes(cap["buf"]))
                            if m:
                                # bytes pattern -> bytes group; the session map
                                # is a str-keyed JSON file
                                sid = m.group(0).decode("utf-8", "replace")
                                _pinned[0] = True
                                _pin(sid, pin_create)
                                log(f"pinned {sid} -> shard {pin_create} (create-sniff)")
                    dst.sendall(d)
            except Exception: cap["ok"] = False
            finally:
                if capture: done.set()
                try: dst.shutdown(socket.SHUT_WR)
                except: pass
        t1 = threading.Thread(target=pipe, args=(c, u), daemon=True)
        t2 = threading.Thread(target=pipe, args=(u, c, cap_flag, True), daemon=True)
        t2.start()
        try: u.sendall(first_chunk)
        except Exception: pass
        t1.start()
        t1.join(); t2.join()
        c.close(); u.close()
        log(f"be-{bid} closed")
        # #1313: name every HTML response to a non-asset path — the opencode SPA
        # fallback serves index.html (200) for routes it doesn't know; clients
        # that JSON.parse it throw "Unexpected token '<'" with no stack frames.
        # The path list in the log IS the culprit list.
        if key is not None and done.is_set() and cap["ok"] and len(cap["buf"]) <= CACHE_MAX:
            b = bytes(cap["buf"])
            if b.startswith(b"HTTP/1.1 200"):
                with cache_lock: cache[key] = (time.time(), b)
        # (create-sniff pinning happens inside the pipe, above — the moment the
        # id bytes flow; a post-join pin loses the race to the client's
        # immediate follow-up request.)
    finally:
        with _dial_lock:
            _dials_in_flight -= 1
            if SHARDED and shard is not None:
                _dials_per_shard[shard] = max(0, _dials_per_shard.get(shard, 1) - 1)

def _no_store_html(chunk: bytes) -> bytes:
    """#1457: rewrite an HTML response's headers to Cache-Control: no-store."""
    try:
        import re as _re_nostore
        head, sep, body = chunk.partition(b"\r\n\r\n")
        if not sep:
            return chunk
        if b"cache-control:" in head.lower():
            head = _re_nostore.sub(rb"[Cc]ache-[Cc]ontrol:[^\r\n]*",
                                  b"Cache-Control: no-store", head)
        else:
            head = head + b"\r\nCache-Control: no-store"
        return head + sep + body
    except Exception:
        return chunk

def serve_question_list(c, first, raw):
    """2026-10-07: GET /question across a pooled directory — pending questions
    are PROCESS-LOCAL, so the true list is the union of every member's; one
    member's list misses questions posed by the others (the panel saw exactly
    that once sessions moved off the default shard). Same merge-deadline
    contract as the session list: dead members contribute nothing and delay
    nothing; dedupe by id (the same question never poses twice, but the
    shared DB's read paths make defensive dedupe free)."""
    try:
        target = first.split(b"\r\n", 1)[0].split(b" ")[1].decode("utf-8", "replace")
    except Exception:
        target = raw
    d = _directory_of(raw)
    pool = TABLE["pools"].get(d) if d else None
    if not pool or len(pool) < 2:
        passthrough_capture(c, first, key=None, shard=TABLE["default_shard"])
        return
    deadline = float(_env("AMICODE_MERGE_DEADLINE", "5"))
    results = [None] * len(pool)
    threads = []
    def fetch(i, shard):
        results[i] = backend_get(target, timeout=deadline, shard=shard)
    for i, shard in enumerate(pool):
        t = threading.Thread(target=fetch, args=(i, shard), daemon=True)
        t.start(); threads.append(t)
    for t in threads:
        t.join(deadline + 1.0)
    merged = {}
    for b in results:
        if not b: continue
        try:
            arr = _json0.loads(b)
        except Exception:
            continue
        if isinstance(arr, list):
            for q in arr:
                if isinstance(q, dict) and q.get("id") is not None:
                    merged[q["id"]] = q
    if not merged:
        # an empty pending list is a legitimate answer — serve it as one
        merged = {}
    body = _json0.dumps(list(merged.values())).encode()
    hdr = ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
           + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n")
    try:
        c.sendall(hdr.encode() + body)
    except Exception:
        pass
    c.close()

def serve_session_list(c, first, raw):
    """#1717 phase 1: GET /session across the pool. A pooled directory merges
    every member (threads, 8s dial timeout each -- a dead member contributes
    nothing); unpooled / absent directories passthrough to the default shard.
    Computed per request -- directory-scoped responses are never shared across
    clients (standing rule)."""
    try:
        target = first.split(b"\r\n", 1)[0].split(b" ")[1].decode("utf-8", "replace")
    except Exception:
        target = raw
    d = _directory_of(raw)
    pool = TABLE["pools"].get(d) if d else None
    if not pool or len(pool) < 2:
        passthrough_capture(c, first, key=None, shard=TABLE["default_shard"])
        return
    results = [None] * len(pool)
    threads = []
    # 2026-10-07: the docstring always promised "a dead member contributes
    # nothing" but the join was unbounded and backend_get's default timeout
    # is 60s — one wedged shard hung every session-list switch for a full
    # minute (the "switching sessions is laggy" reports). The deadline makes
    # the promise real: slow members miss the merge, the rest answer.
    deadline = float(_env("AMICODE_MERGE_DEADLINE", "5"))
    def fetch(i, shard):
        results[i] = backend_get(target, timeout=deadline, shard=shard)
    for i, shard in enumerate(pool):
        t = threading.Thread(target=fetch, args=(i, shard), daemon=True)
        t.start(); threads.append(t)
    for t in threads:
        t.join(deadline + 1.0)
    lists = []
    for b in results:
        if not b:
            continue
        try:
            lists.append(_json0.loads(b))
        except Exception:
            pass
    if not lists:
        _shed_503(c, retry_after=10)
        return
    body = _json0.dumps(_merge_session_lists(lists)).encode()
    hdr = ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
           + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n")
    try:
        c.sendall(hdr.encode() + body)
    except Exception:
        pass
    c.close()

def passthrough(c, first_chunk):
    passthrough_capture(c, first_chunk, key=None)

def handle(c, addr, cid):
    try:
        first = b""
        while b"\r\n\r\n" not in first:
            chunk = c.recv(65536)
            if not chunk: c.close(); return
            first += chunk
        line = first.split(b"\r\n", 1)[0].decode("utf-8", "replace")
        parts = line.split()
        path = parts[1] if len(parts) > 1 else "/"
        path = path.split("?")[0]
        try:
            if not hasattr(_last_req, "setdefault") if False else False: pass
        except Exception:
            pass
        _last_req[cid] = line[:140]
        ua_census(first, path)
        if path == "/snapshot" and parts[0] == "GET":
            log(f"#{cid} SNAPSHOT {line.split('?')[1] if '?' in line else ''}")
            serve_snapshot(c, first, parts[1])
            return
        log(f"#{cid} {line}")
        # --- #1723: the build surface — one request answers "what UI is live"
        if path == "/__amicode_ui_build" and parts[0] == "GET":
            rec, ok = _ui_floor_ok()
            _serve_bytes(c, _json0.dumps({
                "commit": rec["commit"] if rec else None,
                "built_at": rec["built_at"] if rec else None,
                "floor_ok": ok}).encode(), "application/json")
            return
        # --- #1290 client-error log: the app's debug badge POSTs captured
        # errors here (Solid routes reactive teardowns through console.error,
        # invisible to window.onerror). Append to a file; answer 204.
        if parts[0] == "POST" and path == "/__amicode_client_log":
            try:
                clen = 0
                for seg in first.decode("utf-8", "replace").split("\r\n"):
                    if seg.lower().startswith("content-length:"):
                        clen = int(seg.split(":", 1)[1].strip())
                body = b""
                if b"\r\n\r\n" in first:
                    body = first.split(b"\r\n\r\n", 1)[1]
                while len(body) < clen:
                    chunk = c.recv(65536)
                    if not chunk: break
                    body += chunk
                with open("/home/aaron/.amico/server/client-errors.log", "ab") as f:
                    f.write(body.rstrip(b"\r\n") + b"\n")
            except Exception as e:
                log(f"client-log write failed: {e}")
            try:
                c.sendall(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except Exception:
                pass
            c.close()
            return
        # --- 2026-09-04 caps (#775 mitigation): starve the attach-boot leak feed ---
        raw = parts[1] if len(parts) > 1 else "/"
        if parts[0] == "GET" and raw.split("?")[0] == "/question" and SHARDED:
            serve_question_list(c, first, raw)
            return
        if parts[0] == "GET" and raw.split("?")[0] == "/session":
            import re
            capped, n = re.subn(rb"([?&])limit=\d+", rb"\g<1>limit=100", first)
            if n:
                first = capped
                log(f"#{cid} capped /session limit to 100")
            # #1717 phase 1: the session list spans every shard of a pooled
            # directory (each shard's list is a shared-DB superset today, so the
            # merge dedupes; Phase 2 partitions DBs and it becomes a true
            # union). Unpooled / absent directories passthrough to the default.
            if SHARDED:
                serve_session_list(c, first, raw)
                return
            key = None   # directory-scoped responses must NEVER be shared across clients
        if path in ("/event", "/global/event"):
            # #1717 slice 1c: the client-facing event streams are MERGED across
            # the pool -- the wire /event is directory-scoped and session-less
            # (WorkspaceRoutingQuery has no session param), so the union of all
            # pool members' streams is the only stream that carries
            # off-default sessions' frames. A session id in the target (no
            # known client does this today) keeps sticky single-shard semantics.
            if SHARDED:
                m = _SES_RE.search(raw)
                if m:
                    with _sess_map_lock:
                        g_shard = _sess_map.get(m.group(0), TABLE["default_shard"])
                    g = _get_group(g_shard, path)
                else:
                    g = _get_merged_group(path)
            else:
                g = GROUPS[(1, path)]
            last_eid = None
            try:
                qs = raw.split("?", 1)[1] if "?" in raw else ""
                for kv in qs.split("&"):
                    if kv.startswith("lastEventID="):
                        import urllib.parse as _up
                        last_eid = _up.unquote(kv[len("lastEventID="):]) or None
            except Exception:
                last_eid = None
            g.join(c, last_eid)
            def waiter():
                while True:
                    try:
                        d = c.recv(1)
                        if not d: break
                    except Exception: break
                g.leave(c)
                try: c.close()
                except: pass
            threading.Thread(target=waiter, daemon=True).start()
        elif parts[0] == "GET" and path.startswith("/assets/"):
            # 2026-10-04: .js assets must flow through the fetch-patch-cache path
            # below (the openKeyCursor draft-store patch is still needed -- the
            # canary carries the literal). Non-js assets serve straight from APP_DIST.
            if not path.endswith(".js") and app_dist_serve(c, path):
                return
            if not path.endswith(".js"):
                passthrough(c, first)
                return
            # 2026-09-19 veil fix: the hub binary embedded SPA predates amicode#1245 —
            # session.tsx passes degraded={streamGap()} (a VALUE) where SessionStreamVeil
            # calls props.degraded() — every tab switch / send / new session threw
            # "t.degraded is not a function" and blanked the panel for every fleet client.
            # Content-hashed asset URLs are immutable: fetch once from the backend,
            # rewrite the same-length literal, cache the patched response forever.
            key = "asset:" + path
            with cache_lock:
                hit = cache.get(key)
            if hit is None:
                try:
                    import subprocess as _sp
                    r = _sp.run(["curl", "-s", "-m", "10", f"http://{BACKEND[0]}:{BACKEND[1]}" + path],
                                capture_output=True, timeout=15)
                    body = r.stdout
                    # #1723: HTML (or emptiness) answering a content-hashed .js
                    # request IS the revert signature — #1313's "Unexpected
                    # token '<'" class, the stale-client signal the logs held
                    # all along. Heal it: valid JS, one reload hop to the
                    # no-cache index. (The backend's SPA fallback serves the
                    # index for routes it doesn't know — that is what makes a
                    # dead asset look like HTML here.)
                    _head = body.lstrip()[:15].lower()
                    if not body or _head.startswith((b"<!doctype", b"<html")):
                        log(f"UI-REVERT caught: dead asset {path} answered "
                            + ("HTML" if body else "nothing") + " — healing reload")
                        _serve_bytes(c, _UI_HEAL_JS, "text/javascript; charset=utf-8",
                                     extra_headers="Cache-Control: no-store\r\n")
                        return
                    n = body.count(b"degraded:t.degraded(),label")
                    if n:
                        body = body.replace(b"degraded:t.degraded(),label",
                                            b"degraded:t.degraded  ,label")
                        log("patched %s (%d veil call site(s))" % (path, n))
                    else:
                        log("no veil literal in %s" % path)
                    # 2026-09-19 draft-store GC crash (webview console evidence):
                    # upstream app draft-store.ts opens the blobs store with
                    # openKeyCursor() and calls cursor.delete() — key cursors
                    # do not support delete, so the first orphaned draft blob
                    # (created by every send) throws an uncaught
                    # InvalidStateError and blanks the app (send + tab switch).
                    m = body.count(b"openKeyCursor()")
                    if m:
                        body = body.replace(b"openKeyCursor()", b"openCursor()")
                        log("patched %s (%d draft-store key cursor(s))" % (path, m))
                    else:
                        log("no draft-store cursor in %s" % path)
                except Exception as e:
                    log("asset fetch failed %s (%s) — passing through" % (path, e))
                    passthrough(c, first)
                    return
                resp = (b"HTTP/1.1 200 OK\r\nContent-Type: text/javascript; charset=utf-8\r\n"
                        + b"Cache-Control: public, max-age=31536000, immutable\r\n"
                        + ("Content-Length: %d\r\nConnection: close\r\n\r\n" % len(body)).encode()
                        + body)
                with cache_lock:
                    cache[key] = (time.time(), resp)
                hit = (time.time(), resp)
            try:
                c.sendall(hit[1])
            except Exception: pass
            c.close()
        elif parts[0] == "GET":
            if path == "/":
                # 2026-09-19 atomic-serve fix: if the app-dist is (transiently)
                # broken, FAIL LOUD (503) — never fall through to the stale
                # passthrough index: a client that loads during a dist swap
                # window used to get the OLD embedded app and cache it ("I
                # land in an old version of amicode every reload"). A 503
                # makes the browser retry the same URL instead.
                if app_dist_serve(c, "/"):
                    return
                log("app-dist serve FAILED for / - 503 (never serve the stale passthrough index)")
                try:
                    c.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 2\r\nConnection: close\r\n\r\n")
                except Exception:
                    pass
                c.close()
                return
                # SPA index: cached 60s, background refresh via curl (keep-alive-proof),
                # stale-serve always once we hold any copy. The attach machine probes
                # GET / every 2s; each uncached pass leaks server-side (#775).
                key = "/?index"
                hit = cache_get(key, ttl=INDEX_TTL)
                if hit is not None:
                    try: c.sendall(hit)
                    except Exception: pass
                    c.close(); return
                if index_refresh.acquire(blocking=False):
                    threading.Thread(target=refresh_index, daemon=True).start()
                with cache_lock: stale = cache.get(key)
                if stale is not None:
                    try: c.sendall(stale[1])
                    except Exception: pass
                    c.close(); return
                passthrough_capture(c, first, key=None)
                return
            # #1309: document-ish routes (SPA deep links like /server/{b64}/...)
            # have no file extension. Falling through to the backend served
            # opencode's ANCIENT embedded app (no badge, months-old UI) on
            # every webview reload that re-requested a deep document URL.
            # Serve the CURRENT app for all of them — the embedded app is
            # dead forever.
            import re as _re0
            # #1313: the SPA fallback serves the index ONLY to document
            # NAVIGATIONS (sec-fetch-dest: document). #1309's blanket form
            # served HTML to app FETCHES that previously got honest 404s —
            # the client's JSON.parse blew up with "Unexpected token '<'"
            # and the route boundary masked the whole panel as the frozen
            # hold ("stuck loading a new session"). A navigation reloads the
            # app; a fetch wants data.
            _dest = b"sec-fetch-dest: document" in first.lower()
            if ("." not in path.split("?")[0].split("/")[-1]
                and _dest
                and not path.startswith(("/api/", "/event", "/global/", "/experimental/", "/session", "/config", "/provider", "/path", "/project", "/command", "/agent", "/permission", "/question", "/mcp", "/lsp", "/vcs", "/file", "/touched", "/amico", "/snapshot", "/__amicode", "/__test", "/asset"))):
                log(f"#{cid} SPA-INDEX {path[:60]} (nav)")
                if app_dist_serve(c, "/"):
                    return
            key = path
            hit = cache_get(key)
            if hit is not None:
                try:
                    c.sendall(hit)
                except Exception: pass
                c.close()
            else:
                # 2026-09-19: no capture for "/?index" — keep-alive captures
                # complete late (upstream idle timeout) and overwrite the
                # refresh_index entry (the BUSTED index) with RAW bytes long
                # after the refresh wrote it. refresh_index is the SOLE writer.
                passthrough_capture(c, first, key=None, shard=_route(raw) if SHARDED else None)
        else:
            # #1717 phase 1: POST /session CREATES a session — place it on the
            # directory's pool (least-loaded; ties -> lowest id), then pin the
            # server-created id to the serving shard by sniffing the response
            # (the client only learns the id from this response; every later
            # request must stick to the creating shard).
            if SHARDED and parts[0] == "POST" and path == "/session":
                d = _directory_of(raw)
                pool = TABLE["pools"].get(d) if d else None
                if pool and len(pool) == 1:
                    passthrough_capture(c, first, key=None, shard=pool[0], pin_create=pool[0])
                    return
                shard = place_session(None, d, raw) if pool else TABLE["default_shard"]
                passthrough_capture(c, first, key=None, shard=shard, pin_create=shard)
                return
            passthrough_capture(c, first, key=None, shard=_route(raw) if SHARDED else None)
    except Exception as e:
        log(f"#{cid} err {e}")
        try: c.close()
        except: pass

# #1717 phase 1: AMICODE_FRONTDOOR_PORT lets tests (and any future secondary
# frontdoor) run an instance on an ephemeral port; production keeps 4096.
try:
    PORT = int(_env("AMICODE_FRONTDOOR_PORT", "4096"))
except ValueError:
    PORT = 4096
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", PORT)); srv.listen(128)
# 2026-09-19 origin shift: fleet clients' Chromium HTTP cache holds the
# binary-era index (stored without revalidation headers) and self-assembles
# the whole app from cache on every reload — app updates NEVER reach them.
# The app now also listens on 4097; fleet.json points clients there. A fresh
# origin has no cache anywhere. 4096 stays for the watchdog + stragglers.
srv2 = socket.socket(); srv2.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv2.bind(("0.0.0.0", PORT + 1)); srv2.listen(128)
log("front-door v3 (sharded-router, #1717 phase 1) listening %d+%d -> %s"
    % (PORT, PORT + 1,
       ("%d shards, default %d" % (len(TABLE["backends"]), TABLE["default_shard"])) if SHARDED
       else ("%s:%d (legacy)" % (BACKEND[0], BACKEND[1]))))
cid = 0
def accept_loop(sock):
    global cid
    while True:
        c, a = sock.accept()
        with cid_lock:
            cid += 1
            n = cid
        threading.Thread(target=handle, args=(c, a, n), daemon=True).start()

cid_lock = threading.Lock()
import threading as _th
_th.Thread(target=accept_loop, args=(srv2,), daemon=True).start()
while True:
    accept_loop(srv)
