# fleet-watchdog — RSS guard for the canonical opencode server (erlich)

The #775 wedge series (2026-09-03/04, again 2026-10-03): the canonical
engine's RSS climbs into a **TCP-accepts-HTTP-silent wedge** — ports accept,
HTTP never answers, main thread spins, every client panel hangs at "booting".
Polling clients feed the wedged server, so it never self-recovers; the only
exit is a restart. This watchdog samples RSS every 5 minutes with restart
authority to break the trap, and every sample is logged — `rss-trajectory.log`
doubles as the #775 dataset.

## Why it exists in the repo now (2026-10-04)

The wedge re-fired Oct 3 and ran ~7 h undetected because the deployed script
was never versioned here and its default `pgrep` pattern was broken **twice
over**:

1. `opencode serve --port=4095` — wrong port since the M3 cutover (#955
   moved the engine to 4094);
2. `--port=4095` (equals) vs the engine's actual cmdline `--port 4094`
   (space) — the pattern could never have matched on **any** port, before or
   after M3.

Every 5-min sample logged `pid=none status=server-missing` since Oct 2. The
fixed default matches by **binary path** — immune to port moves and separator
style:

```
WATCHDOG_PATTERN default → $HOME/.amico/server/bin/opencode serve
```

Incident capture: `~/.amico/server/incidents/20261003-wedge/` on erlich.

## Deploy (erlich, one-time — the repo is the source of truth)

```bash
scp ops/fleet-watchdog/rss-watchdog.sh erlich:.amico/server/fleet-watchdog/
scp ops/systemd/rss-watchdog.{service,timer} erlich:.config/systemd/user/
ssh erlich 'systemctl --user daemon-reload && systemctl --user enable --now rss-watchdog.timer'
```

## Verify

```bash
tail -2 ~/.amico/server/fleet-watchdog/rss-trajectory.log   # erlich
# expect: pid=<real engine pid> rss_kb=… — NEVER "pid=none status=server-missing"
# (a server-missing streak means the pattern broke again: check the engine cmdline)
```

Knobs (env overrides): `WATCHDOG_THRESHOLD_KB` (default 1536000 = 1.5 GB,
healthy baseline ~400–700 MB), `WATCHDOG_SERVICE`
(`co.harmoniqs.amicode-server.service`), `WATCHDOG_PATTERN`, `WATCHDOG_LOG_DIR`.

Runtime state (never in this repo): `rss-trajectory.log` under
`~/.amico/server/fleet-watchdog/` on erlich.
