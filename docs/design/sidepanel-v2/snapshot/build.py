#!/usr/bin/env python3
"""Build snapshot.js for the side-panel v2 mocks from REAL on-disk state.

Read-only over: ~/.amico/runs, ~/.amico/problems, the personal vault's session
ledgers, the chat DB (opened mode=ro), and strumento's demo device. Output is a
single `window.SNAP = {...}` file so the mocks open from file:// with no server.

Every number in the mocks traces back to a field here; `provenance` records the
source path of each block. Re-run to refresh:  python3 build.py > ../snapshot.js
"""

import csv
import datetime as dt
import glob
import json
import os
import re
import sqlite3
import sys

HOME = os.path.expanduser("~")
RUNS = f"{HOME}/.amico/runs"
PROBLEMS = f"{HOME}/.amico/problems"
VAULT = os.environ.get("AMICO_VAULT", f"{HOME}/armonia/data/vaults/vault-aaron")
DB = os.environ.get("OPENCODE_DB", f"{HOME}/.local/share/opencode/opencode.db")
STRUMENTO = os.environ.get("STRUMENTO", f"{HOME}/harmoniqs/strumento")
FIXTURE = os.path.join(
    os.path.dirname(__file__), "../../../../packages/amico-run/fixtures/bridge/2026-08-31-strumento-task-b3a7"
)

CAMPAIGNS = [
    # (director session, slug, ledger, run lab or None)
    ("ses_e8be4ae58ffeRxkz3wN4iVGcNX", "gkp-prestissimo", "sessions/session-20261025-prestissimo-hybrid.md", "bosonic-gkp-qubit"),
    ("ses_e8aef2c7dffeegfMbbczvzGPMc", "qmotion-autotune", "sessions/session-20261014-qmotion-autotune.md", "qmotion-autotune"),
    ("ses_e7d6f70baffegle2hX1DOdRtoc", "qilc-measurement", "sessions/session-20261028-qilc-measurement-design.md", None),
    ("ses_e84e66ab6ffem20PHUtFUzeVQ5", "qpilc-open-problems", "sessions/session-20260902-qpilc-algorithm-open-problems.md", None),
]

# Heuristic only: ledgers carry free-text verdicts, so the class is a guess (spec
# §C.3 asks the director to write `verdict_class` explicitly). Order matters.
VERDICT_CLASSES = [
    ("stopped", r"STOPPED|SUPERSEDED|MOOT|DEFERRED|VOID"),
    ("open", r"^(OPEN|SEED|QUEUED|untested|NOT RUN|PRE-REGISTERED)|^—$|^-$"),
    ("partial", r"PARTIAL|MIXED|CELL-DEPENDENT|NARROW|RESHAPED|UNRESOLVED|OBSERVED|NULL"),
    ("refuted", r"REFUTED|HURTS|HARMFUL|NOT CONFIRMED|FAIL"),
    ("confirmed", r"CONFIRMED|DELIVERED|SUPPORTED|WINS|HOLDS|RESOLVED|POS\b|-CAUSED|-ONLY"),
]


def parse_run_id_time(rid):
    m = re.match(r"r(\d{8})[T-](\d{6})Z", rid)
    if not m:
        return None
    return dt.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc).timestamp()


def read_toml_str(path, key):
    if not os.path.exists(path):
        return None
    m = re.search(rf'^{key}\s*=\s*"?([^"\n]+)"?', open(path).read(), re.M)
    return m.group(1).strip() if m else None


def run_record(rd):
    rid = os.path.basename(rd)
    log = os.path.join(rd, "run.log")
    if not os.path.exists(log):
        return None
    text = open(log, errors="replace").read()
    series = [
        {"i": int(m.group(1)), "f": float(m.group(2)), "pr": float(m.group(3)), "du": float(m.group(4))}
        for m in re.finditer(r"AMICODE_ITER iter=(\d+) f=([-\d.e+]+) inf_pr=([-\d.e+]+) inf_du=([-\d.e+]+)", text)
    ]
    outer = [
        {"s_per": float(m.group(1)), "F": float(m.group(2))}
        for m in re.finditer(r"([\d.]+) s/outer .*?F_ms ([\d.]+)", text)
    ]
    t0 = parse_run_id_time(rid)
    t1 = os.path.getmtime(log)
    status = read_toml_str(os.path.join(rd, "FINISHED"), "status") or "running"
    rc = re.search(r"rc=(\d+)", text)
    return {
        "id": rid,
        "lab": os.path.basename(os.path.dirname(rd)),
        "executor": read_toml_str(os.path.join(rd, "run.toml"), "executor") or "local",
        "trust": read_toml_str(os.path.join(rd, "run.toml"), "trust"),
        "status": status,
        "rc": int(rc.group(1)) if rc else None,
        "t0": t0,
        "t1": t1,
        # wall time is INFERRED (run-id stamp → last log write) unless result.toml has wall_seconds
        "wall_s": float(read_toml_str(os.path.join(rd, "result.toml"), "wall_seconds") or 0) or (t1 - t0 if t0 else None),
        "wall_measured": read_toml_str(os.path.join(rd, "result.toml"), "wall_seconds") is not None,
        "series": series,
        "outer": outer,
        "tags": {k: re.findall(rf"^\[{k}\] (.*)$", text, re.M) for k in ("phase", "gate", "cost", "event", "label")},
    }


def runs_for(lab):
    out = [r for r in (run_record(rd) for rd in sorted(glob.glob(f"{RUNS}/{lab}/r*"))) if r]
    return sorted(out, key=lambda r: r["t0"] or 0)


def ledger(path):
    full = os.path.join(VAULT, path)
    text = open(full, errors="replace").read()
    fm = dict(re.findall(r"^(status|title|campaign|posture|created|date):\s*\"?([^\"\n]+)\"?", text.split("\n---", 1)[0], re.M))
    hyps = []
    sec = re.search(r"^## 2\.?[^\n]*\n(.*?)^## ", text, re.M | re.S)
    for row in (sec.group(1) if sec else "").splitlines():
        cells = [c.strip() for c in re.split(r"(?<!\\)\|", row.strip().strip("|"))]
        if len(cells) < 3 or cells[0] in ("H#", "ID", "---") or set(cells[0]) <= {"-"}:
            continue
        hid = cells[0]
        # verdict column is the 3rd for H#|hyp|verdict|evidence; some ledgers add a date column
        verdict = cells[3] if re.match(r"\d{4}-\d{2}-\d{2}", cells[1] or "") and len(cells) > 3 else cells[2]
        bold = re.search(r"\*\*([^*]+)\*\*", verdict)
        label = (bold.group(1) if bold else verdict.split("—")[0].split("(")[0]).strip().strip("*").strip()[:60]
        cls = next((c for c, rx in VERDICT_CLASSES if re.search(rx, label)), "open")
        # "(update)" rows re-verdict an earlier id: keep the latest verdict, first position
        prev = next((h for h in hyps if h["id"] == hid), None)
        if prev:
            prev.update(label=label or "—", cls=cls)
            continue
        hyps.append({"id": hid, "label": label or "—", "cls": cls})
    loops = re.findall(r"^\s*[-|]?\s*\**LOOP (\d+)", text, re.M)
    return {
        "path": path,
        "status": fm.get("status", "?"),
        "title": fm.get("title"),
        "mtime": os.path.getmtime(full),
        "hypotheses": hyps,
        "loops": max((int(x) for x in loops), default=None),
        "handoff": bool(re.search(r"HANDOFF", text)),
    }


def campaign_costs(db, rid):
    def role(title, agent):
        if agent and agent not in ("build", "general", "plan"):
            return agent
        m = re.search(r"@(\w+) subagent", title or "")
        if m:
            return m.group(1)
        return "critic" if (title or "").lower().startswith("critic") else "director"

    root = db.execute("select title,time_created,time_updated,cost,model from session where id=?", (rid,)).fetchone()
    frontier, kids = [rid], []
    while frontier:
        rows = db.execute(
            f"select id,title,agent,time_created,time_updated,cost from session where parent_id in ({','.join('?' * len(frontier))})",
            frontier,
        ).fetchall()
        kids += rows
        frontier = [r[0] for r in rows]
    by = {}
    for k in kids:
        r = "critic" if (k[1] or "").lower().startswith("critic") else role(k[1], k[2])
        b = by.setdefault(r, {"n": 0, "usd": 0.0, "agent_h": 0.0})
        b["n"] += 1
        b["usd"] += k[5] or 0
        b["agent_h"] += (k[4] - k[3]) / 3.6e6
    busy = db.execute("select time_heartbeat from runtime_busy where session_id=?", (rid,)).fetchone()
    recent = sorted(kids, key=lambda k: -k[4])[:6]
    return {
        "title": root[0],
        "created": root[1] / 1e3,
        "updated": root[2] / 1e3,
        "director_usd": root[3] or 0,
        "model": root[4],
        "casts": len(kids),
        "by_role": by,
        "heartbeat": busy[0] / 1e3 if busy else None,
        "cast_spans": [
            {"t0": k[3] / 1e3, "t1": k[4] / 1e3, "role": "critic" if (k[1] or "").lower().startswith("critic") else role(k[1], k[2]), "usd": round(k[5] or 0, 2)}
            for k in kids
        ],
        "recent": [
            {"id": k[0], "title": re.sub(r"\s*\(@\w+ subagent\)", "", k[1] or ""), "role": role(k[1], k[2]),
             "start": k[3] / 1e3, "end": k[4] / 1e3, "usd": k[5] or 0}
            for k in recent
        ],
    }


def measurement():
    base = f"{PROBLEMS}/qilc-m1b-module/run"
    rows = [r for r in csv.DictReader(l for l in open(f"{base}/m1b_designs.csv") if not l.startswith("#"))]
    designs = [
        {"pulse": r["pulse"], "ctx": r["ctx"], "design": r["design"], "rows": int(r["nrows"]), "R": float(r["R_L"]),
         "share": {k[6:]: float(r[k]) for k in r if k.startswith("share_") and float(r[k] or 0) > 0}}
        for r in rows if r["ctx"] == "th0"
    ]
    arms_src = f"{PROBLEMS}/qpilc-h32c-designed/run/h32c_arms.csv"
    arms = [
        {"cmp": r["comparison"].split("=")[0].strip(), "expr": r["comparison"].split("=", 1)[1].strip() if "=" in r["comparison"] else "",
         "reading": r["reading"], "label": r["label"], "mean": float(r["mean"]), "lo": float(r["ci_lo"]), "hi": float(r["ci_hi"]),
         "n": int(r["n_pairs"])}
        for r in csv.DictReader(l for l in open(arms_src) if not l.startswith("#"))
    ]
    return {"designs": designs, "arms": arms,
            "provenance": {"designs": f"{base}/m1b_designs.csv", "arms": arms_src}}


def calibration():
    # No YAML dependency: the calibration block is flat `key: number` lines under
    # `qubit:` / `readout:`, plus one-line `{...}` pulse maps.
    dev_path = f"{STRUMENTO}/devices/multimode_demo/device.yaml"
    text = open(dev_path).read().split("\ncalibration:", 1)[1]
    cal, section = {}, None
    for line in text.splitlines():
        m = re.match(r"^  (\w+):\s*$", line)
        if m:
            section = cal.setdefault(m.group(1), {})
            continue
        m = re.match(r"^    (\w+):\s*([-\d.e]+)\s*$", line)
        if m and section is not None:
            section[m.group(1)] = float(m.group(2))
            continue
        m = re.match(r"^      (\w+):\s*\{(.*)\}", line)
        if m and section is not None:
            section.setdefault("pulses", {})[m.group(1)] = dict(
                (k.strip(), v.strip()) for k, v in (kv.split(":") for kv in m.group(2).split(","))
            )
    prog = [json.loads(l) for l in open(os.path.join(FIXTURE, "progress.jsonl"))]
    return {
        "device": "multimode_demo",
        "synthetic": True,
        "qubit": cal.get("qubit", {}),
        "readout": cal.get("readout", {}),
        "task": {"id": read_toml_str(os.path.join(FIXTURE, "task.toml"), "id"),
                 "config": read_toml_str(os.path.join(FIXTURE, "task.toml"), "config_content_id"),
                 "summary": read_toml_str(os.path.join(FIXTURE, "result.toml"), "summary"),
                 "events": prog},
        "provenance": {"device": dev_path, "task": os.path.normpath(FIXTURE)},
    }


def files(root, since, open_file):
    """A two-level tree of a problem workspace, with changed = written after `since`."""
    out = []
    for d in sorted(os.listdir(root)):
        full = os.path.join(root, d)
        if not os.path.isdir(full):
            continue
        kids = []
        for f in sorted(os.listdir(full)):
            p = os.path.join(full, f)
            kids.append({"name": f, "dir": os.path.isdir(p), "mtime": os.path.getmtime(p),
                         "changed": os.path.getmtime(p) > since, "size": os.path.getsize(p) if os.path.isfile(p) else None})
        out.append({"name": d, "dir": True, "children": kids})
    text = open(os.path.join(root, open_file)).read().splitlines()[:40]
    return {"root": root.replace(HOME, "~"), "tree": out, "open": {"path": open_file, "lines": text}}


def thin(run, keep=160):
    s = run["series"]
    step = max(1, len(s) // keep)
    run = dict(run)
    run["series"] = s[::step] + ([s[-1]] if s and s[-1] is not s[::step][-1] else [])
    return run


def main():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    campaigns = []
    for rid, slug, lpath, lab in CAMPAIGNS:
        c = {"session": rid, "slug": slug, **campaign_costs(db, rid), "ledger": ledger(lpath)}
        if lab:
            rs = runs_for(lab)
            c["runs"] = [
                {k: v for k, v in thin(r).items() if k not in ("outer",)}
                for r in rs
            ]
        campaigns.append(c)
    snap = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "campaigns": campaigns,
        "measurement": measurement(),
        "calibration": calibration(),
        "files": files(f"{PROBLEMS}/qilc-m1b-module", campaigns[2]["created"], "run/m1b_branch.toml"),
        "provenance": {"runs": RUNS, "vault": VAULT, "db": DB + " (mode=ro)"},
    }
    sys.stdout.write("// generated by snapshot/build.py — real on-disk state, read-only\nwindow.SNAP = ")
    json.dump(snap, sys.stdout, separators=(",", ":"))
    sys.stdout.write(";\n")


if __name__ == "__main__":
    main()
