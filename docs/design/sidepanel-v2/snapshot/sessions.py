#!/usr/bin/env python3
"""Build sessions.js: one record bundle per currently running root session.

Read-only over the chat DB (mode=ro), run dirs and vault ledgers. Everything the
session-specific Now panels show comes from here; nothing is typed in by hand.
    python3 snapshot/sessions.py > sessions.js
"""

import collections
import datetime as dt
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from build import DB, RUNS, VAULT, ledger, run_record, thin  # noqa: E402

LIVE_MS = 10 * 60 * 1000
RECENT_MS = 4 * 3600 * 1000
KINDS = ("research", "develop", "build", "plan")


def role_of(title, agent):
    if (title or "").lower().startswith("critic"):
        return "critic"
    m = re.search(r"@(\w+) subagent", title or "")
    return m.group(1) if m else (agent or "general")


def descendants(db, rid):
    out, frontier = [], [rid]
    while frontier:
        rows = db.execute(
            f"select id,title,agent,time_created,time_updated,cost from session where parent_id in ({','.join('?' * len(frontier))})",
            frontier,
        ).fetchall()
        out += rows
        frontier = [r[0] for r in rows]
    return out


def tool_inputs(db, ids, limit=4000):
    q = f"select time_created, data from part where session_id in ({','.join('?' * len(ids))}) and json_extract(data,'$.type')='tool' order by time_created desc limit {limit}"
    for t, d in db.execute(q, ids):
        yield t, json.loads(d)


def pr_state(repo, n, cache={}):
    """Title and state from GitHub; empty on any failure (the panel then shows the number only)."""
    if (repo, n) not in cache:
        try:
            out = subprocess.run(["gh", "pr", "view", n, "-R", repo, "--json", "title,state"], capture_output=True, text=True, timeout=20)
            cache[(repo, n)] = json.loads(out.stdout) if out.returncode == 0 else {}
        except Exception:
            cache[(repo, n)] = {}
    return cache[(repo, n)]


def main():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    now = time.time() * 1000
    beats = dict(db.execute("select session_id, time_heartbeat from runtime_busy"))
    roots = db.execute(
        f"select id,title,agent,model,time_created,time_updated,cost from session where parent_id is null and time_archived is null and agent in ({','.join('?' * len(KINDS))}) and time_updated > ? order by time_updated desc",
        (*KINDS, now - RECENT_MS),
    ).fetchall()
    out = []
    for sid, title, agent, model, t0, t1, cost in roots:
        if (title or "").startswith("Side panel watcher"):
            continue  # this design session itself
        kids = descendants(db, sid)
        ids = [sid] + [k[0] for k in kids]
        live = lambda i: beats.get(i) and now - beats[i] < LIVE_MS  # noqa: E731
        # files written, ledger, runs and PRs, all from this session tree's own tool calls
        writes, runs, prs, running = collections.Counter(), set(), [], None
        for t, p in tool_inputs(db, ids):
            st = p.get("state", {})
            inp = st.get("input") or {}
            blob = json.dumps(inp) + str((st.get("metadata") or {}).get("output", ""))[:4000] + str(st.get("output", ""))[:4000]
            if p.get("tool") in ("edit", "write") and inp.get("filePath"):
                writes[inp["filePath"]] += 1
            for m in re.finditer(r"\.amico/runs/([\w.-]+)/(r[\w.-]+)", blob):
                runs.add((m.group(1), m.group(2)))
            # only PRs this session opened, not every PR URL it happened to read
            if p.get("tool") == "bash" and "gh pr create" in str(inp.get("command", "")):
                for m in re.finditer(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)", blob):
                    if (m.group(1), m.group(2)) not in [(x["repo"], x["n"]) for x in prs]:
                        prs.append({"repo": m.group(1), "n": m.group(2), "t": t / 1e3})
            if running is None and st.get("status") == "running":
                desc = inp.get("description") or inp.get("command") or inp.get("filePath") or inp.get("prompt") or ""
                running = {"tool": p.get("tool"), "what": str(desc).splitlines()[0][:120], "since": (st.get("time") or {}).get("start", t) / 1e3}
        ledgers = [(n, f) for f, n in writes.items() if re.search(r"/(session|campaign)-20\d{6}-[\w-]+\.md$", f)]
        led = None
        if ledgers:
            path = max(ledgers)[1]
            rel = path.split("/vault-aaron/", 1)[-1] if "/vault-aaron/" in path else None
            try:
                led = ledger(rel) if rel else None
            except Exception:
                led = None
        run_recs = []
        for lab, rid in sorted(runs, key=lambda x: x[1], reverse=True)[:40]:
            d = os.path.join(RUNS, lab, rid)
            if os.path.isdir(d):
                r = run_record(d)
                if r and r["t1"] >= t0 / 1e3:  # written during this session, not merely mentioned
                    run_recs.append(thin(r, 80))
        run_recs = sorted(run_recs, key=lambda r: r["t1"], reverse=True)[:6]
        todos = [dict(content=c, status=s) for c, s in db.execute("select content,status from todo where session_id=? order by position", (sid,))]
        pending = db.execute(
            f"select kind, data from runtime_pending where state='pending' and session_id in ({','.join('?' * len(ids))})", ids
        ).fetchall()
        last_text = db.execute(
            "select p.data from part p join message m on m.id=p.message_id where p.session_id=? and json_extract(p.data,'$.type')='text' and json_extract(m.data,'$.role')='assistant' order by p.time_created desc limit 1",
            (sid,),
        ).fetchone()
        text = json.loads(last_text[0]).get("text", "") if last_text else ""
        first = re.split(r"(?<=[.!?])\s", re.sub(r"[*_`#>]", "", text).strip().replace("\n", " "), maxsplit=1)[0][:220]
        by_role = collections.defaultdict(lambda: {"n": 0, "usd": 0.0})
        for k in kids:
            b = by_role[role_of(k[1], k[2])]
            b["n"] += 1
            b["usd"] += k[5] or 0
        out.append({
            "id": sid, "title": title, "agent": agent, "model": json.loads(model or "{}").get("id"),
            "created": t0 / 1e3, "updated": t1 / 1e3, "live": bool(live(sid)),
            "usd": (cost or 0) + sum(k[5] or 0 for k in kids), "director_usd": cost or 0,
            "casts": len(kids), "by_role": by_role,
            "casts_live": [{"title": re.sub(r"\s*\(@\w+ subagent\)", "", k[1] or ""), "role": role_of(k[1], k[2]), "start": k[3] / 1e3} for k in kids if live(k[0])],
            "recent": [{"title": re.sub(r"\s*\(@\w+ subagent\)", "", k[1] or ""), "role": role_of(k[1], k[2]), "end": k[4] / 1e3, "usd": k[5] or 0, "live": bool(live(k[0]))} for k in sorted(kids, key=lambda k: -k[4])[:6]],
            "running": running, "todos": todos,
            "files": [{"path": f.replace(os.path.expanduser("~"), "~"), "n": n} for f, n in writes.most_common(40)],
            "ledger": led, "runs": run_recs, "prs": [{**p, **pr_state(p["repo"], p["n"])} for p in prs[:6]],
            "pending": [{"kind": k, "q": (json.loads(d).get("questions") or [{}])[0].get("question") if k == "question" else json.loads(d).get("permission")} for k, d in pending],
            "said": first,
        })
    sys.stdout.write("// generated by snapshot/sessions.py — live root sessions, read-only\nwindow.SESSIONS = ")
    json.dump({"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "sessions": out}, sys.stdout, separators=(",", ":"))
    sys.stdout.write(";\n")


if __name__ == "__main__":
    main()
