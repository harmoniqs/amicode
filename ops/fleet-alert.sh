#!/usr/bin/env bash
# fleet-alert.sh — the MISSING half of fleet-status: transitions → Slack.
# fleet-status.sh (launchd, 5 min) writes the JSON; this reads it, diffs
# against a state file, and posts DEVICE TRANSITIONS only to #fleet.
# Noise-gated: one post per transition; steady states never post; a device
# down >24h re-reminds once daily. The 2026-08-18 inciting incident: erlich
# dark 16h, zero alerts — the widget was green-passive.
#
# 2026-08-19 re-point (the #amicode thread): alerts move to #fleet, and only
# ALERT_DEVICES notify — always-on hosts (mini, erlich). Laptops (macbook)
# stay in fleet-status.json for the dashboard but never post: "I shouldn't
# get a notification even in #fleet everytime aaron closes his laptop" (jj).
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
STATUS="$HOME/.amico/ops/fleet-status.json"
STATE="$HOME/.amico/ops/fleet-alert.state"
CH="fleet"
ALERT_DEVICES="mini erlich"   # space-separated; devices here and ONLY here notify
[ -f "$STATUS" ] || exit 0
python3 - "$STATUS" "$STATE" "$ALERT_DEVICES" << 'PY' > /tmp/fleet-alert-msg 2>/dev/null
import json, sys, time, subprocess, os
status, statef, alert_dev = sys.argv[1], sys.argv[2], set(sys.argv[3].split())
now = time.time()
try:
    cur = {d["name"]: d["reachable"] for d in json.load(open(status)).get("devices", [])}
except Exception:
    sys.exit(0)
prev, meta = {}, {}
try:
    j = json.load(open(statef)); prev = j.get("devices", {}); meta = j.get("meta", {})
except Exception:
    pass
msgs, changed = [], False
for name, up in cur.items():
    was = prev.get(name)
    if was is None and not up:
        continue  # first run ever: don't announce pre-existing darkness silently recorded
    if was != up:
        changed = True
        if not up: meta[f"down_since:{name}"] = now
        else: meta.pop(f"down_since:{name}", None); meta.pop(f"reminded:{name}", None)
        if name not in alert_dev:
            continue  # monitored for the dashboard, never posted (laptops sleep — not news)
        msgs.append(f"{'🟢' if up else '🔴'} `{name}` {'reachable' if up else 'UNREACHABLE'}" + (f" (was {'reachable' if was else 'unreachable'})" if was is not None else ""))
for name in list(cur):
    if name not in alert_dev:
        continue
    ds = meta.get(f"down_since:{name}")
    if ds and not cur[name] and now - ds > 86400 and meta.get(f"reminded:{name}", 0) < now - 86400:
        msgs.append(f"⏰ still down >24h: `{name}`"); meta[f"reminded:{name}"] = now
json.dump({"devices": cur, "meta": meta}, open(statef, "w"))
if msgs:
    text = "*fleet:* " + " · ".join(msgs)
    token = open(os.path.expanduser("~/.amico/slack/token")).read().strip()
    channels = json.load(open(os.path.expanduser("~/.amico/slack/channels.json")))
    cid = channels.get("fleet")
    if cid:
        subprocess.run(["curl", "-sS", "-X", "POST", "https://slack.com/api/chat.postMessage",
            "-H", f"Authorization: Bearer {token}", "-H", "Content-type: application/json",
            "--data-binary", json.dumps({"channel": cid, "text": text})], capture_output=True)
PY
exit 0
