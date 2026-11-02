# @amicode/host — amicode-host skeleton (H1a, #2061)

The host that will front Amicode's opencode **v2** server: one Bun process that embeds the published
`@opencode/server` route builder behind our own **deny-by-default authenticating front**, with its own
registration file, an exclusive start lock per database, and a mandatory file database.
Part of #2043 · ADR 0039 (D1–D3) · seam evidence: `docs/spikes/2026-11-01-h0c-seam.md`.

**Runs on Bun only** (1.4.x). `bin/amicode-host.mjs` refuses to start under Node with exit 64 and a clear
message: under Node the V1 → V2 importer is a silent no-op and its migrations drop data
(`docs/spikes/2026-11-01-h0b-importer.md`).

## Run

```sh
AMICODE_HOST_DB=/path/to/amicode-host.db \
AMICODE_HOST_PASSWORD_FILE=/path/to/password   `# mode 0600` \
AMICODE_HOST_PORT=<port> \
  bun packages/host/bin/amicode-host.mjs
```

On success it prints one JSON line (`{"event":"listening","url":…,"pid":…,"db":…}`) and serves until
`SIGTERM`/`SIGINT`. Clients use Basic auth with user name `opencode` (so stock clients can speak to it) and
the host password.

### Environment (flags `--db`, `--port`, `--lock-wait-ms`, `--resume`, `--registration-file`, `--password-file`, `--server-options` override)

| Variable | Default | Meaning |
|---|---|---|
| `AMICODE_HOST_DB` | **required** | Database file. Empty, `:memory:`, `file::memory:` or `mode=memory` ⇒ refuse (exit 64). |
| `AMICODE_HOST_PASSWORD` / `AMICODE_HOST_PASSWORD_FILE` | **one required** | The password. A file must not be readable by group/others (refused otherwise). No password ⇒ refuse: the host never serves open. |
| `AMICODE_HOST_PORT` | `0` (OS-chosen; the production default is chosen at install) | Loopback port. `49374`/`49375` (the machine service) are refused. |
| `AMICODE_HOST_LOCK_WAIT_MS` | `30000` | How long a second start waits for the lock holder to exit before failing (exit 69, naming the pid). |
| `AMICODE_HOST_RESUME` | `1` | `0` ⇒ do not resume suspended sessions at start (see below). |
| `AMICODE_HOST_REGISTRATION_FILE` | `$XDG_STATE_HOME/amicode/host.json` | The host's own advertisement. Stock paths (`…/opencode/*`, `service*.json`) are refused. |
| `AMICODE_HOST_SERVER_OPTIONS` | `{}` | JSON object merged into the `@opencode/server` options (config dir, models, fs …). `password`, `port`, `hostname`, `database` are host-owned and rejected. |

Exit codes: `0` clean shutdown · `64` refused (config / runtime) · `69` database lock held · `1` startup failure.

## Modules

| File | Concern |
|---|---|
| `src/config.ts` | env/flags → validated config; every refusal is a `ConfigError`. |
| `src/lock.ts` | `<db>.amicode-host.lock`, `O_EXCL`; live holder ⇒ wait then fail; dead holder (pid gone, or pid reused — Linux start-time check) ⇒ stale takeover, serialised on a second `O_EXCL` file. |
| `src/registration.ts` | `{ id, version, url, pid, startedAt }`, **no password**, mode 0600, atomic rename, removed on exit only if still ours. |
| `src/front.ts` | Deny-by-default over the whole `fetch`: Basic auth, constant-time compare, 401 + `WWW-Authenticate` for **every** path before any routing. Returns the upstream `Response` untouched. |
| `src/routes.ts` | Host-owned `/amicode/*`: `GET /amicode/ping`, `GET /amicode/health` (db basename, uptime, lock-holder pid, open streams, resume flag). Unknown `/amicode/*` is a 404 from us. |
| `src/listener.ts` | The one listener: `127.0.0.1`, `idleTimeout: 0`. |
| `src/server-seam.ts` | **The only module that imports the opencode server.** |
| `src/main.ts`, `bin/amicode-host.mjs` | Wiring, lifecycle, graceful shutdown; the plain-JS launcher that refuses Node. |

Shutdown order: remove registration → stop listener → close engine (flushes the db) → release lock last, so
a waiting successor never overlaps this process's use of the database.

## The seam, and the swap plan for #2054

H0c preferred the SDK's embedded host (`@opencode/sdk/internal/host`). The **published** 2.2.5 SDK hides it
behind its `exports` map (`ERR_MODULE_NOT_FOUND` outside the upstream workspace), so the host builds on the
published `@opencode/server/routes` `createRoutes` (H0c candidate 2a), which honours a password.
`server-seam.ts` exports `createServer(opts) → { fetch, openStreams, close }` and nothing else leaks.
When the upstream export of the embedded host lands (#2054), the swap is confined to the body of
`createServer` in that one file (`EmbeddedHost.create(...)` → map `.fetch` / `.close`).

The peer set is **pinned exactly** (`@opencode/{server,core,sdk,protocol,schema}` `2.2.5`, `effect` `4.0.6`);
`test/seam.test.ts` fails if a pin becomes a range, if the installed copy differs, or if the surface the seam
uses (`createRoutes`, `SessionRestart`, the Effect web-handler helpers) drifts.

### Resume of suspended sessions

`createRoutes` does **not** resume suspended sessions (`ServerFetch.make` and the node server process fork
`SessionRestart.resumeSuspendedSessions` themselves; the embedded host does so unconditionally). Here it is
the host's decision: with `AMICODE_HOST_RESUME=1` (default) it is forked once after the routes are built;
with `0` it never runs and a claim (`session_v2.time_suspended`) is left exactly as found. Both are tested
(`resume of suspended sessions`). The sweep assumes every orphaned claim's owner is dead — the start lock is
what makes that true here.

### Observing "abort releases the subscription" against the published package

The event feed's per-client subscriber map is private. What *is* observable from the seam: every request
runs in its own `Scope`, a streaming response holds it open until the client disconnects, and the feed's
subscription is released by finalizers of that same scope. The seam registers a finalizer first (so it runs
last) and counts open request scopes: `GET /amicode/health` → `openStreams` goes `0 → 1 → 0` around a
connect/abort. This is the scope that owns the subscription, not a read of the subscriber map itself.
The negative control (a front that pumps the body leaks the stream) lives in `test/front.test.ts`.

## Safety properties

- Never registers as, replaces, or reads the stock service registration (`<state>/opencode/service*.json`);
  never listens on `49374/49375`. Tested with a decoy registration (bytes, mtime and pid untouched) and with a
  FIFO sitting on the stock path (an `open()` would hang; the host starts and leaves it intact).
- Listens on `127.0.0.1` only. One listener, owned by the front; `host.fetch` is not reachable otherwise.
- Never serves without a password; never an in-memory database; never two servers on one database.
- The password appears in no log, error, health body or registration file.

## Tests

```sh
cd packages/host
env -u BUN_INSPECT -u AMICODE_ENGINE_INSPECT bun test     # ~1 min; includes the ~15 s heartbeat test
bun run typecheck
```

Every process the tests start runs in a sandbox (`test/helpers.ts`): from-scratch environment, temp
`XDG_{STATE,DATA,CONFIG,CACHE}_HOME` and `HOME`, a fresh database file under a temp dir, a random password
per run, and **loopback ports 52000–52999 only** (never `49374/49375`, `4094–4296`, `9229–9231`,
`51000–51999`, never `--service`). Resumed turns are made to fail locally (`OPENCODE_DISABLE_FREE_MODELS=1`);
no model is called and no credential exists. CI: the `host-tests` job in `.github/workflows/ci.yml`
(Bun 1.4.2); the `fast` job excludes this package from its Node-tooling `pnpm -r run test`.

## Not done here (by scope)

- **Plugins** (in-process registration, #2062), the application routes port, the fleet, the UI.
- **Ticketed WebSocket / pairing URLs** (pty, persistent-pty, mcp tickets, pairing connect) are authenticated
  by tickets rather than Basic credentials upstream; deny-by-default blocks them until the front learns the
  exact allow-list.
- **CORS** and response compression (the node server process adds both); **schedules** (`Schedule.run` is
  forked by the node server process, not here); request tracing/logging layers.
- Production defaults: the real port, where the password file lives, service/unit installation.
- `XDG_*`/`HOME` are the process's own: the engine's global dirs (logs, auth, config) follow them, so a
  production unit should give the host its own state/data directories rather than the hub's.
