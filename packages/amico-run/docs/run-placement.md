# Run placement — each solve outside the engine's process group (#2045)

`amico run` used to start Julia inside the engine's process group, so a crash, an OOM kill, a
reboot or a manual restart of the engine unit destroyed a running solve and left nothing behind.
Now the **orchestrator** (the process that owns the Julia child, `run.log`, `FINISHED`, the
ledger stanza and the free-tier verification) runs as its own transient user service when the
host can do that, and the `amico run` you typed becomes a **thin client** that follows it.

## Flow

```
amico run …            gate → warrant → solver-mode → duplicate-spec guard → prepareRun
   │                   (run dir, run.toml, solvespec.json, index, latest — manifest FIRST, as before)
   ├─ placement unit → systemd-run --user --unit=amico-run-<runId> … amico run --adopt <runDir> --unit <name>
   │                   client: tail run.log → FINISHED → verification → AMICODE_* lines
   └─ placement none → startRun in this process (today's behaviour), protection recorded as `none`
```

The gate and warrant run **once**, in the client. `--adopt` skips them, the solver-mode check and
run-dir creation.

## Placement ladder

`AMICO_RUN_PLACEMENT` = `auto` (default) | `unit` | `none`.

1. Linux only for `unit`. Otherwise (macOS) the run is in-process and reported as unprotected.
2. Probe, cached per process: `systemd-run --user --quiet --collect --wait /bin/true` succeeds
   **and** `loginctl show-user $USER -p Linger --value` is `yes`.
   If not: stderr `amico-run: NOT protected from engine restarts (no user service manager / lingering off); running in-process`, `run.lock.protection = "none"`.
3. `unit`: `systemd-run --user --unit=amico-run-<runId>.service --collect --property=Type=exec --property=TimeoutStopSec=30 --property=KillMode=mixed --working-directory=<runDir> --setenv=… <node> <amico entry> run --adopt <runDir> --unit <name>`.
   `KillMode=mixed` makes `stop` TERM only the orchestrator, which aborts the run and kills Julia's
   group itself, so the verdict is `aborted`, not a racing `failed 143`.
   If `systemd-run` fails after the probe passed, the launcher says so and falls back to in-process.
4. `AMICO_RUN_PLACEMENT=none` forces the in-process path (silently). `unit` is treated like
   `auto` (a probe failure still degrades, loudly — a refused solve is worse than an unprotected one).
5. `AMICO_RUN_UNIT_PREFIX` (must match `amico-run-[a-z0-9-]*`; default `amico-run-`) names the
   units. Tests use `amico-run-test-`.

### Environment of a placed run

An **allowlist**, passed with `--setenv`, never the whole environment (credentials must not land
in the systemd manager): `PATH HOME USER LOGNAME LANG TMPDIR SHELL LD_LIBRARY_PATH`, `JULIA_*`,
`AMICO_*`, `AMICODE_*` (not `AMICODE_ENGINE_INSPECT`), `XDG_*`, `SSL_CERT_*`, plus names listed in
`AMICO_RUN_PASS_ENV` (comma-separated). Within the prefix families, names that look like
credentials (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `*PRIVATE_KEY*`, `*CREDENTIAL*`) are
dropped; name one in `AMICO_RUN_PASS_ENV` to pass it deliberately. `BUN_INSPECT` is never passed.

## Client behaviour and exit codes

stdout (every `run.log` line, `AMICODE_VERIFIED`, `AMICODE_FINISHED`) and the exit code are
byte-identical to the in-process launcher: 0 completed, 130 aborted, julia's rc on failure.
`run.log` is flushed **before** `FINISHED` is written, so a client that stops at `FINISHED` never
loses the last lines.

| Signal to the client | `unit` placement | `none` placement (client = orchestrator) |
|---|---|---|
| `SIGTERM` | **detach**: stderr `amico-run: detached; run <id> continues — stop it with: amico run stop <id>`, exit **143** | abort the run (unchanged) |
| `SIGHUP` | **detach**, exit **129** | abort (unchanged) |
| `SIGINT` | stop the unit; report `aborted`, exit 130 | abort, 130 (unchanged) |

Agents that time out a tool call must now call `amico run stop <id>`: the signal no longer
stops the solve.

| Exit | Meaning |
|---|---|
| 64 | config error, gate refusal, duplicate-spec refusal, `stop`/`attach` target not found |
| 69 | **the run is DEAD**: heartbeat stale (>90 s) or orchestrator gone, no `FINISHED` (client message names the run dir) |
| 129 / 143 | client detached on SIGHUP / SIGTERM |

## `stop` and `attach`

* `amico run stop <runId|runDir>` (or `--stop <id>`): reads `run.lock`. Unit run →
  `systemctl --user stop <unit>`. Unit-less run → SIGTERM to `lock.pid` **after verifying** it is
  that orchestrator (same host, process exists, `/proc/<pid>/cmdline` is an `amico`/`--adopt`
  process or names the run dir; otherwise refuses with exit 1). Idempotent: an already-finished
  run is exit 0. Use `--runs-root <path>` / `--lab <id>` to say where the id lives (default: every
  lab under the studio runs root).
* `amico run attach <runId|runDir>` (or `--attach <id>`): tails `run.log` from the beginning and
  finishes exactly like the launcher. An `attach` only observes: Ctrl-C detaches, it does not stop.
* The subcommand form applies only when the first argument is exactly `stop`/`attach` **and** the
  next argument is a run id (`r20261101-193000Z-abc1`) or a run directory, so a script literally
  named `stop` still launches.

## `run.lock`

`<runDir>/run.lock`, JSON, atomic (temp + rename, 0644), written by the orchestrator right after
`prepareRun`, heartbeat every 30 s (`AMICO_RUN_HEARTBEAT_MS` overrides, test knob), final write
`ended: true` immediately **before** `FINISHED`. Fields: `schema run_id unit pid host spec_hash
protection cloud_run_id started_at heartbeat_at ended`. `pid` is the orchestrator. See
`~/.amico/vaults/vault-aaron/amicode/scratchpad/run-lock-contract.md` (shared with #2055).

Liveness rule: **dead** iff `run.lock` exists ∧ no `FINISHED` ∧ `ended !== true` ∧
`now − heartbeat_at > 90 s`.

Free-tier local runs also get a **pending verification marker** (`verification.toml`:
`agree = false`, `pending = true`, `reason = "pending"`) written *before* `FINISHED`; the real
verification (or the failure fallback) overwrites it without `pending`. Consumers must treat
`pending = true` as "not verified yet", not as a disagreement.

Order at settle: flush `run.log` → pending marker → lock `ended:true` → `FINISHED` → ledger stanza.

## Duplicate-spec guard

For `--spec` runs, after the gate and before any run dir exists: if a run in the same runs root
holds a **live** lock (`ended` false, no `FINISHED`, heartbeat < 90 s — or is prepared and younger
than 90 s with no lock yet) with the same `spec_hash`, the launch is refused (exit 64, names the
run). Dead, ended and finished runs never block, so deliberate re-runs (seed sweeps, retries) work.
Bare runs are never refused. The warrant check reads `solve` rows written at settle time, so a
refusal here consumes no warrant.

## Restart-guard integration (A0)

Under `none` placement the child lands in the engine's cgroup. The launcher holds
`$SOLVE_GUARD_LOCK_DIR/<unit>.lock` (default `~/.amico/server/restart-locks`) **shared** from
"decide placement" until the child is spawned, where `<unit>` comes from `/proc/self/cgroup`
(`co.harmoniqs.amicode-server[@N].service`; no hub unit → skipped). `ops/hub/solve-guard.sh`
holds the same lock exclusive across check → recheck → restart, so the restart can no longer
interleave between a launch's decision and its child appearing, and a restart that wins the lock
first makes the launch wait. Implemented by a `flock -s` helper child (no native binding exists;
no dependency added); if the lock cannot be taken in 130 s the launch warns and continues.
