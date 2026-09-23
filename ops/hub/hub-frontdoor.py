import queue as _qmod
import socket, threading, time

APP_DIST = "/home/aaron/.amico/server/app-dist"
BACKEND = ("127.0.0.1", 4095)
LOG = open("/home/aaron/.amico/server/frontdoor.log", "a", buffering=1)
_last_req = {}
def log(m): LOG.write(time.strftime("%H:%M:%S ") + m + "\n")

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

def backend_get(target, timeout=60):
    """One-shot localhost GET. Slow answers stream; only failures return None."""
    try:
        s = socket.create_connection(BACKEND, timeout=8)
        s.settimeout(timeout)
        s.sendall(("GET " + target + " HTTP/1.1\r\nHost: 127.0.0.1:4095\r\nConnection: close\r\nAccept-Encoding: identity\r\n\r\n").encode())
        buf = b""
        while True:
            d = s.recv(262144)
            if not d: break
            buf += d
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

def build_snapshot(top):
    import json as _json
    health = backend_get("/global/health")
    if health is None: return None
    lst = backend_get("/session?limit=100")   # same cap the frontdoor enforces on client lists
    if lst is None: return None
    try: sessions = _json.loads(lst)
    except Exception: return None
    if isinstance(sessions, dict):
        sessions = sessions.get("sessions") or sessions.get("data") or []
    messages = {}
    trimmed = set()
    def pull(sid):
        b = backend_get("/session/" + sid + "/message?limit=20")
        if not b: return
        try: page = _json.loads(b)
        except Exception: return
        raw = len(b)
        page = _trim(page)
        if len(_json.dumps(page)) < raw - 64:   # something was actually trimmed
            trimmed.add(sid)
        messages[sid] = page
    ids = [s.get("id") for s in sessions if isinstance(s, dict) and s.get("id")][:top]
    ths = [threading.Thread(target=pull, args=(i,)) for i in ids]
    for t in ths: t.start()
    for t in ths: t.join()
    last_eid = None
    try:
        g = GROUPS.get("/global/event")
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
        return serve_file(c, _p.join(APP_DIST, "index.html"), "text/html; charset=utf-8", "no-cache")
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
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.members = {}    # member socket -> outbound queue.Queue
        self.preamble = b""
        self.upstream = None
        self.history = []   # [(event_id, frame_bytes)] — bounded ring
        self.reasm = b""    # frame reassembly buffer (upstream side)
        threading.Thread(target=self.upstream_loop, daemon=True).start()
    def build_preamble(self):
        req = f"GET {self.path} HTTP/1.1\r\nHost: 127.0.0.1:4095\r\nAccept: text/event-stream\r\n\r\n".encode()
        s = socket.create_connection(BACKEND)
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
    def upstream_loop(self):
        backoff = 0.5
        while True:
            try:
                s, pre = self.build_preamble()
            except Exception as e:
                log(f"[{self.path}] upstream down ({e}); retry in {backoff}s")
                time.sleep(backoff); backoff = min(backoff * 2, 5); continue
            backoff = 0.5
            frames, tail = _parse_frames(pre)
            self.reasm = tail
            with self.lock:
                self.upstream = s
                self.preamble = pre
                self.history = []   # history spans the NEW upstream's stream
                n_waiting = len(self.members)
            log(f"[{self.path}] upstream live ({n_waiting} waiting members)")
            try:
                while True:
                    chunk = s.recv(65536)
                    if not chunk: break
                    self.reasm += chunk
                    frames, self.reasm = _parse_frames(self.reasm)
                    for frame in frames:
                        # #1306: state changed — the snapshot cache must not
                        # outlive the events that changed it.
                        try:
                            if b'"message.' in frame or b'"session.' in frame or b'"server.' in frame:
                                if b'"server.heartbeat' not in frame:
                                    snapshot_invalidate()
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
                                except Exception: pass
                                log(f"[{self.path}] member dropped — stalled (queue full)")
                                continue
                            for frame in frames:
                                q.put(frame)
            except Exception: pass
            try: s.close()
            except: pass
            with self.lock:
                self.upstream = None
                members = list(self.members)
            for m in members:
                self.leave(m)
                try: m.close()
                except: pass
            log(f"[{self.path}] upstream lost; closed {len(members)} members")
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

GROUPS = {p: Group(p) for p in ("/event", "/global/event")}

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
        r = subprocess.run(["curl", "-s", "-m", "5", "http://127.0.0.1:4095/"],
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

def passthrough_capture(c, first_chunk, key=None, force_close=False):
    """Passthrough; capture small fast 200 GET responses for the cache."""
    bid = id(c) % 10000
    try: u = socket.create_connection(BACKEND, timeout=8)
    except Exception as e:
        log(f"upstream fail: {e}")
        try:
            # #1310: Retry-After 10 — a 2s Retry-After AMPLIFIED client retries
            # into a 2s-cadence storm against a busy backend.
            c.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 10\r\n\r\n")
        except Exception: pass
        c.close(); return
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
                dst.sendall(d)
        except Exception: cap["ok"] = False
        finally:
            if capture: done.set()
            try: dst.shutdown(socket.SHUT_WR)
            except: pass
    t1 = threading.Thread(target=pipe, args=(c, u), daemon=True)
    t2 = threading.Thread(target=pipe, args=(u, c, key is not None, True), daemon=True)
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
        if parts[0] == "GET" and raw.split("?")[0] == "/session":
            import re
            capped, n = re.subn(rb"([?&])limit=\d+", rb"\g<1>limit=100", first)
            if n:
                first = capped
                log(f"#{cid} capped /session limit to 100")
            key = None   # directory-scoped responses must NEVER be shared across clients
        if path in GROUPS:
            g = GROUPS[path]
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
            if app_dist_serve(c, path):
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
                    r = _sp.run(["curl", "-s", "-m", "10", "http://127.0.0.1:4095" + path],
                                capture_output=True, timeout=15)
                    body = r.stdout
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
                passthrough_capture(c, first, key=None)
        else:
            passthrough(c, first)
    except Exception as e:
        log(f"#{cid} err {e}")
        try: c.close()
        except: pass

srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", 4096)); srv.listen(128)
# 2026-09-19 origin shift: fleet clients' Chromium HTTP cache holds the
# binary-era index (stored without revalidation headers) and self-assembles
# the whole app from cache on every reload — app updates NEVER reach them.
# The app now also listens on 4097; fleet.json points clients there. A fresh
# origin has no cache anywhere. 4096 stays for the watchdog + stragglers.
srv2 = socket.socket(); srv2.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv2.bind(("0.0.0.0", 4097)); srv2.listen(128)
log("front-door v2.1 (sse-splitter) listening 4096 -> 4095")
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
