# Fleet hardening — lid-close / internet-loss (#324)

Operational fix applied 2026-08-09, captured here as versioned template.

## Problem

Closing the MacBook lid killed the `ssh -L 127.0.0.1:4096` tunnel, so chat appeared to stop even though `Aarons-Mac-mini` (canonical server, `co.harmoniqs.amicode-server`, `opencode-dev.db` 707 sessions) kept running. Tunnel used `ServerAliveInterval 30 / CountMax 3` (90s detection) and the fleet guard was missing on the mini with a stale `~/harmoniqs` path, so a port-race could fork a laptop-local `opencode.db` during reconnect gaps.

## Fix (applied on hosts)

* **Guard** — `amico-opencode-fleet-guard` installed to `~/.local/bin` on both hosts. Client exits 1 (panel rides tunnel), server execs frozen `~/.amico/server/bin/opencode` falling back to VSIX. Prevents silent fork (ADR 0005, #279, #324).
* **Tunnel** — `co.harmoniqs.amico-tunnel.plist` tuned to `ServerAliveInterval 15 / CountMax 2 / TCPKeepAlive yes` (30s detection, matches `amico-mini` Host `ServerAliveInterval 15`). LAN-first `Match host amico-mini exec "ping -c1 -W1000 Aarons-Mac-mini.local"` keeps tunnel up on same Wi-Fi with no internet.
* **Hygiene** — forked `opencode.db` archived on macbook to `~/.local/share/opencode/archive/`, `~/.config/opencode/opencode.json` symlink repointed to `vault-aaron`, duplicate `Host the-feynmachine` removed.

## Verification

```
lsof -nP -iTCP:4096 -sTCP:LISTEN  # ssh LISTEN, no opencode
curl http://127.0.0.1:4096/session  # 200 via tunnel
sqlite3 ~/.local/share/opencode/opencode-dev.db "SELECT COUNT(*) FROM session;" # 707 on mini
cat ~/.amico/ops/fleet-status.json # guard ok, served 639
```

Lid-close/wake or LAN-only internet loss: tunnel respawns via `KeepAlive` within ~30s.

## Install

```bash
cp tools/fleet/amico-opencode-fleet-guard ~/.local/bin/amico-opencode-fleet-guard
chmod +x ~/.local/bin/amico-opencode-fleet-guard
# scope: machine — never synced
# settings.json: "amicode.opencodeBinary": "/Users/aaron/.local/bin/amico-opencode-fleet-guard"
```
