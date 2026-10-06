# ops/hub — the erlich hub's serving stack, source of truth

This directory is the **source of truth** for the hub's frontdoor, server
wrapper, and RSS watchdog. Until 2026-10-05 these existed only as
hand-maintained files on the hub (`~/.amico/server/`), unversioned — the
router we re-architected for amicode #1717 Phase 1 could not be developed
against a file that lived nowhere. This import fixes that.

| File | Live deploy target (erlich) | Role |
| --- | --- | --- |
| `hub-frontdoor.py` | `~/.amico/server/hub-frontdoor.py` | Connection-serializing proxy, 4096 → the amicode service (see `incidents/20260903-wedge`); owns routing, SSE fan-out, snapshot cache |
| `amicode-server.sh` | `~/.amico/server/amicode-server.sh` | systemd wrapper: binary resolution, skill staging, env, spawns the service runner (M3 cutover, #955) |
| `fleet-watchdog/rss-watchdog.sh` | `~/.amico/server/fleet-watchdog/rss-watchdog.sh` | 5-min RSS trajectory + corroboration probe + wedge capture + restart authority |
| `fleet-watchdog/cdp-stack.mjs` | `~/.amico/server/fleet-watchdog/cdp-stack.mjs` | CDP all-threads JS stack capture for wedge postmortems (connects to the engine's BUN_INSPECT port) |

Unit files live in `ops/systemd/` (existing convention for fleet services).
The hub's live units are in `~/.config/systemd/user/`.

## The shard model (amicode #1717 Phase 1)

One engine process cannot carry the fleet: all active sessions share one JS
event loop and one heap; under parallel load the loop saturates, the
watchdog's probe goes silent, and the restart kills every session at once
(9 kills on 2026-10-04/05 overnight, more on 10-05/06 — see
`rss-trajectory.log` on the hub). Phase 1 shards the engine into a **pool of
N=3 engine instances** behind the frontdoor, one shard's wedge or restart
costing only that shard's sessions. The shared DB was measured safe for 3
concurrent writers (harness: 0 busy errors, commit p95 ~8 ms at ~50× real
traffic, 2026-10-05 — ledger: session-20261005-jev-routed-pool).

A shard is one instance of the templated unit `co.harmoniqs.amicode-server@N`
and is fully defined by three env vars (derivation lives in `amicode-server.sh`
so units stay trivial):

| Shard | `AMICODE_SERVICE_PORT` | `AMICODE_ENGINE_PORT` | `AMICODE_ENGINE_INSPECT` | unit |
| --- | --- | --- | --- | --- |
| 1 | 4095 | 4094 | 127.0.0.1:9229 | legacy `co.harmoniqs.amicode-server.service` (unchanged) |
| 2 | 4195 | 4194 | 127.0.0.1:9230 | `…@2.service` |
| 3 | 4295 | 4294 | 127.0.0.1:9231 | `…@3.service` |

Shared across shards (intentionally, Phase 1): `OPENCODE_DB` (the one
canonical chat DB), the staged workspace, all `AMICO_*` artifact paths.
**The inspect port MUST be distinct per shard** — two engines with the same
`BUN_INSPECT` fail at boot with EADDRINUSE.

Watchdogs: `rss-watchdog@N.{service,timer}` parameterize the existing script
via its env vars (`WATCHDOG_SERVICE`, `WATCHDOG_PATTERN`, `WATCHDOG_HEALTH_PORT`).
With multiple shards the watchdog's `pgrep` pattern MUST disambiguate by the
shard's engine port (the engine cmdline is `… serve --port <N>` with a SPACE —
see the 2026-10-04 pattern-fix comment in the script); the binary-path-only
default grabs an arbitrary shard's engine via `head -1`.

## Deploy ritual (erlich hub — never skip)

1. **Diff first**: the live copies may have drifted hot-fixed on the hub —
   `diff ops/hub/<file> ~/.amico/server/<file>` before deploying anything;
   reconcile any drift INTO this repo first (a hot fix that lives only on
   the hub is how this directory came to exist).
2. Copy files: `rsync -a ops/hub/ ~/.amico/server/ --exclude fleet-watchdog/wedge-*`
   (or targeted `cp` per file; never touch `rss-trajectory.log`, wedge
   captures, or `*.bak-*` — those are hub-local history).
3. Units: `cp ops/systemd/co.harmoniqs.amicode-server@.service ops/systemd/rss-watchdog@.{service,timer} ~/.config/systemd/user/ && systemctl --user daemon-reload`.
4. **Restart only through the ritual**: `ops/hub-restart.sh` (or
   `systemd-run`/the panel button) — NEVER an inline `systemctl restart` from
   an agent hosted on the hub (the standing rule from the 2026-09 incidents;
   restarts race the agent's own tool loop).
5. Verify: `hub-upgrade-smoke.sh` (grows router checks in Phase 1), then
   watch `~/.amico/server/fleet-watchdog/rss-trajectory.log` per shard.

Rollback: the hub keeps `*.bak-*` copies beside every live script it has ever
hot-fixed; the pre-Phase-1 single-shard posture is shard 1's legacy unit —
disabling the pool = stop `…@2` / `…@3`, point the frontdoor's route table
back at shard 1 for everything (single-entry table), restart the frontdoor.

## Provenance

- Imported 2026-10-05 (amicode #1717 Phase 1 campaign) verbatim from the
  erlich hub's live copies. Any change to these files happens HERE, in a PR,
  and deploys by the ritual above — the hub copies are build outputs.
