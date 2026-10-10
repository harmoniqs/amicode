# ops/hub — the erlich hub's serving stack, source of truth

This directory is the **source of truth** for the hub's frontdoor, server
wrapper, and RSS watchdog. Until 2026-10-05 these existed only as
hand-maintained files on the hub (`~/.amico/server/`), unversioned — the
router we re-architected for amicode #1717 Phase 1 could not be developed
against a file that lived nowhere. This import fixes that.

| File | Live deploy target (erlich) | Role |
| --- | --- | --- |
| `hub-frontdoor.py` | `~/.amico/server/hub-frontdoor.py` | Connection-serializing proxy, 4096 → the amicode service (see `incidents/20260903-wedge`); owns routing, SSE fan-out, snapshot cache |
| `client-log-freshness.sh` | `~/.amico/server/client-log-freshness.sh` | #1745: mechanical freshness check on the panel telemetry log — age of the newest heartbeat, loudly reported (exit 0 fresh / 1 stale, never-heartbeat, or missing) |
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
   `client-log-freshness.sh` (#1745 — with a panel open, its heartbeat must
   land within a minute; a STALE verdict right after a deploy means the
   client telemetry died again and must NOT pass silently), then watch
   `~/.amico/server/fleet-watchdog/rss-trajectory.log` per shard.

Rollback: the hub keeps `*.bak-*` copies beside every live script it has ever
hot-fixed; the pre-Phase-1 single-shard posture is shard 1's legacy unit —
disabling the pool = stop `…@2` / `…@3`, point the frontdoor's route table
back at shard 1 for everything (single-entry table), restart the frontdoor.

## The frontdoor router (slice 1b)

`hub-frontdoor.py` routes across the pool. Configuration lives in env vars:

| Env | Default | Meaning |
| --- | --- | --- |
| `AMICODE_ROUTING_TABLE` | `~/.amico/server/routing.json` | the shard table (below); missing/unparseable/single-shard = legacy single-backend, byte-compatible with the pre-pool frontdoor — the rollback path AND the no-downtime rollout |
| `AMICODE_SESSION_MAP` | `~/.amico/server/routing-sessions.json` | sticky placements (`{"ses_...": shard}`), write-through, survives frontdoor restarts |
| `AMICODE_MAX_DIALS` | `256` | global in-flight dial ceiling; above it requests get a fast 503 (storms shed, never pile) |
| `AMICODE_FRONTDOOR_PORT` | `4096` | listen port (+1 for the second origin); tests run on ephemeral ports |
| `AMICODE_FRONTDOOR_LOG` | `~/.amico/server/frontdoor.log` | log path |
| `AMICODE_CLIENT_LOG` | `~/.amico/server/client-errors.log` | the `POST /__amicode_client_log` ingest append target (#1745) |
| `AMICODE_HEARTBEAT_ALARM_S` | `180` | heartbeat-canary threshold: with live SSE members and no heartbeat within this window, the frontdoor logs a `HEARTBEAT-ALARM` line (#1745; 3x the panel's ~60s beat) |
| `AMICODE_HEARTBEAT_CHECK_S` | `30` | heartbeat-canary check interval |

Table shape:

```json
{"shards": [{"id": 1, "backend": "127.0.0.1:4095"}, ...],
 "default_shard": 1,
 "directory_pools": {"/home/aaron/harmoniqs/opencode": [1, 2, 3]}}
```

Routing semantics (placement is **admission-time only** — engines hold
process-local session state, in-flight sessions cannot migrate):

- **Known session** → its owning shard, forever (sticky, persisted map).
- **Unknown session on a pooled directory** → placed on the least-loaded pool
  member (in-flight dials + live SSE groups; ties → lowest id) and pinned.
  This is `place_session()` — the deterministic floor that the Jev provider
  (slice 2) wraps and fails open to.
- **POST /session (create)** → placed on the least-loaded member; the
  server-created id is sniffed from the response the moment its bytes flow
  (never after — the client's follow-up request races a post-join pin) and
  pinned to the creating shard.
- **Session-scoped SSE** (`/event?…ses_…`) → the owning shard's group; global
  streams → the default shard's group. Groups are keyed `(shard, path)`.
- **GET /session?directory=… (pooled)** → fan-out merge across every member
  (bare-array envelope, dedupe by id, `time.updated` desc); unpooled
  directories passthrough to the default shard. The snapshot's session list
  fans out the same way.
- **Dead shard** → its requests 503 fast (`Retry-After: 2`); other shards
  unaffected. No per-IP caps — fleet tunnels share addresses; a client-aware
  shed is an open question.
- `SIGHUP` reloads the table (existing SSE groups keep their upstreams until
  restart).

Gates: `python3 ops/hub/test_frontdoor.py` (38-test fake-backend suite —
sticky/persistence, least-loaded placement, fan-out merge, SSE routing,
dead-shard blast radius, dial ceiling, create-sniff pinning, legacy
regressions, the #1745 client-log ingest + heartbeat-alarm canaries) and
`bash ops/hub/test-shard-config.sh` (26 checks, including the
client-log-freshness self-test).

## The Jev placement provider (slice 2)

`jev_placement.py` wraps the floor: at session admission (never per-request,
never for stateless routes), the frontdoor may ask Jev (TypeSafe System One,
the arjev decision model) which pool member should host the new session.
**Advisory-only, fail-open, never load-bearing** — the arjev doctrine,
verbatim: no key, outage, low confidence, or out-of-pool choice → the
deterministic least-loaded floor, and the receipt says why.

Flag-off by default; env surface:

| Env | Default | Meaning |
| --- | --- | --- |
| `AMICODE_JEV_PLACEMENT` | off | the flag; on = the provider answers at admission |
| `ARJEV_JEV_KEY` / `ARJEV_JEV_KEY_FILE` | — | key resolution identical to arjev (env key, then the explicit opt-in file) |
| `ARJEV_JEV_DISABLED` | off | the kill switch (zero behavioral delta, arjev convention) |
| `AMICODE_JEV_URL` | `https://api.typesafe.ai/v1/systemone` | the systemone endpoint (tests point it at a fake) |
| `AMICODE_JEV_TIMEOUT` | `1.5` s | admission carries a live user request; the floor answers while Jev thinks |
| `AMICODE_JEV_MIN_CONFIDENCE` | `0.6` | below it → the floor, `fail_reason: low-confidence` |
| `AMICODE_ROUTING_RECEIPTS` | `~/.amico/server/routing-receipts.jsonl` | one JSONL line per ATTEMPTED call (disabled/no-key write nothing) |

Receipt schema: `ts, session_id, directory, pool, loads, decision, mode
(jev|deterministic), fail_reason, confidence, distribution, latency_ms,
model_version, state_bytes`. This is the calibration dataset — join it with
per-shard wedge/RSS outcomes later (the `arjev calibrate` loop, pointed at
routing). Wire contract: `POST /v1/systemone, {"model": "jev-latest",
"state", "questions": {"placement": {choice over shard ids}}}`; answer
carries `probabilities`, confidence = max probability.

Gates: `python3 ops/hub/test_jev_placement.py` (11 unit tests: gating,
confident override, low-confidence, timeout bounded, garbage, out-of-pool,
HTTP error, state-overflow, dead URL) plus the two integration tests in
`test_frontdoor.py` (`TestJevPlacement`: Jev overrides the floor through the
real frontdoor; low confidence falls to it; sticky after a Jev placement).

## Provenance

- Imported 2026-10-05 (amicode #1717 Phase 1 campaign) verbatim from the
  erlich hub's live copies. Any change to these files happens HERE, in a PR,
  and deploys by the ritual above — the hub copies are build outputs.
