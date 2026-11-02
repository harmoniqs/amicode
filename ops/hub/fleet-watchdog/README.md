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
pattern is now derived **per shard from the engine port** (the cmdline is
`… serve --port <N>`, space-separated) — with three engines running, a
binary-path-only pattern plus `head -1` grabs an arbitrary shard's engine:

```
shard 1 (legacy, no AMICODE_SHARD_INDEX) → $HOME/.amico/server/bin/opencode serve --port 4094
shard N (AMICODE_SHARD_INDEX=N)          → $HOME/.amico/server/bin/opencode serve --port $((4094 + 100*(N-1)))
```

## One canonical script (amicode#2044 / A0, 2026-11-01)

There used to be three diverged copies (the top-level `fleet-watchdog/` copy, this directory,
the hub deploy). This directory is now the only one. It carries: the
**liveness-alone recovery** (two consecutive silent probes ⇒ capture + restart
regardless of RSS, per-shard `http-silent-tick[-shardN]` marker — restored after
the Oct 11 deploy regressed it), the gateway-secret-aware probe, per-shard
config, and **every restart goes through `../solve-guard.sh`**: refused while
compute runs in the unit's process group; after `WATCHDOG_DEFER_ALERT_TICKS`
(12) deferrals an alert marker `$WATCHDOG_ALERT_DIR/live-compute-deferred-<unit>`
is written (and an `alert` line in the decision log) and the watchdog keeps
deferring; `touch ~/.amico/server/restart-override/<unit>` lets a human force
it. See `ops/hub/README.md` ("The restart guard").

Incident capture: `~/.amico/server/incidents/20261003-wedge/` on erlich.

## Deploy (erlich, one-time — the repo is the source of truth)

```bash
scp ops/hub/fleet-watchdog/rss-watchdog.sh erlich:.amico/server/fleet-watchdog/
scp ops/hub/solve-guard.sh erlich:.amico/server/solve-guard.sh   # the watchdog fails closed without it
scp ops/systemd/rss-watchdog.{service,timer} erlich:.config/systemd/user/
ssh erlich 'systemctl --user daemon-reload && systemctl --user enable --now rss-watchdog.timer'
```

## Verify

```bash
tail -2 ~/.amico/server/fleet-watchdog/rss-trajectory.log   # erlich
# expect: pid=<real engine pid> rss_kb=… — NEVER "pid=none status=server-missing"
# (a server-missing streak means the pattern broke again: check the engine cmdline)
```

Knobs (env overrides): `WATCHDOG_THRESHOLD_KB` (default 2621440 = 2.5 GiB,
healthy baseline ~400–700 MB), `WATCHDOG_SERVICE`
(`co.harmoniqs.amicode-server.service`), `WATCHDOG_PATTERN`, `WATCHDOG_LOG_DIR`,
`WATCHDOG_DEFER_ALERT_TICKS` (12), `WATCHDOG_ALERT_DIR`
(`~/.amico/server/alerts`), `WATCHDOG_POST_RESTART_SLEEP` (5).

Runtime state (never in this repo): `rss-trajectory.log` under
`~/.amico/server/fleet-watchdog/` on erlich.
