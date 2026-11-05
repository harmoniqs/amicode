# H0a load harness (#2046)

The harness for `docs/spikes/2026-11-02-h0a-load.md` (pre-registered): does **one** v2 host process (`packages/host`)
stay healthy under the hub's load? This directory builds and smoke-tests the instrument. The real 2-hour levels (L1, L3)
are run by the director. **Nothing here changes the pre-registered pass criteria**; `summarize.ts` copies them
verbatim and its tests pin every boundary.

Not a pnpm workspace member (`pnpm-workspace.yaml` is `packages/*`). Run with Bun 1.4.x. Needs
`pnpm install --filter '@amicode/host...'` once so the host's dependencies exist.

## Run a level

```sh
bash docs/spikes/h0a-harness/run.sh --out /tmp/opencode/h0a/L1 \
  --sessions 12 --duration-s 7200 --warmup-s 300 --seed 1
```

`run.sh` starts `run.ts` under `setsid` so it leads its own process group; `run.ts` refuses to run otherwise (its
teardown signals only that group and must never reach your shell). Always prefix with `env -u BUN_INSPECT -u AMICODE_ENGINE_INSPECT`
(the wrapper also unsets them).

| Flag | Default | |
|---|---|---|
| `--out <dir>` | required, under `/tmp` | run directory (cleared first); holds raw files, logs, `summary.json` |
| `--sessions N` | 12 | concurrent driver sessions (L1 = 12, L3 = 36) |
| `--duration-s` | 7200 | the **measurement window**, after the warm-up |
| `--warmup-s` | 300 | excluded from every criterion (wedges in it are reported, not judged) |
| `--seed` | 1 | model pacing, think-time and reconnect schedule are reproducible from it |
| `--model-min-s` / `--model-max-s` | 2 / 8 | paced turn length (uniform, seeded) |
| `--reconnect-min-s` / `--reconnect-max-s` | 120 / 300 | subscriber abort-and-reconnect interval |
| `--poll-every-s` | 5 | the dashboards' `GET /api/session` + `/api/info` |
| `--sigstop-at-s` / `--sigstop-for-s` | off / 3 | **fault injection** (negative control): SIGSTOP the host, by its recorded pid, that many seconds into the window |
| `--keep-sandbox` | off | keep `<out>/sbx` (the database). Its size is always recorded in `final.json` |

Exit status: `0` pass · `1` fail · `2` inconclusive · `3` invalid input or harness error · `4` something of the run was
left alive · `130`/`143` interrupted. To stop a run early, `kill -TERM` the **runner pid** in `<out>/pids.json` (or
`systemctl --user stop` the unit); it tears everything down and still writes a summary (which will not be a pass).

### As a transient unit (CPU/memory capped, so a runaway cannot hurt the hub)

```sh
systemd-run --user --unit=amico-h0a-L1 --nice=10 -p CPUQuota=400% -p MemoryMax=6G --collect \
  --working-directory=<repo> env -u BUN_INSPECT -u AMICODE_ENGINE_INSPECT \
  bash docs/spikes/h0a-harness/run.sh --out /tmp/opencode/h0a/L1 --sessions 12 --duration-s 7200 --warmup-s 300 --seed 1

systemd-run --user --unit=amico-h0a-L3 --nice=10 -p CPUQuota=400% -p MemoryMax=6G --collect \
  --working-directory=<repo> env -u BUN_INSPECT -u AMICODE_ENGINE_INSPECT \
  bash docs/spikes/h0a-harness/run.sh --out /tmp/opencode/h0a/L3 --sessions 36 --duration-s 7200 --warmup-s 300 --seed 3
```

A transient unit's `PATH` is minimal; `run.sh` falls back to `$HOME/.bun/bin/bun` (or set `H0A_BUN=/path/to/bun` with
`--setenv=H0A_BUN=…`). Add `--wait` to block until it finishes (`--collect` removes the unit afterwards); follow progress with
`journalctl --user -u amico-h0a-L1 -f` and `tail -f <out>/events.ndjson`.

## What runs

| Process | File | Job |
|---|---|---|
| model | `model.ts` | Paced loopback OpenAI-compatible server. Role frame, then content/reasoning frames spread over a seeded 2–8 s, then finish + usage. Every 5th request a `shell` tool call (the host's default-deny policy refuses it, exercising the permission path; the follow-up request gets text), every 7th a reasoning-bearing turn. `GET /__stats` counts requests / active streams / completed / aborted. |
| host | `packages/host/bin/amicode-host.mjs` | The real host, default plugin set, default-deny, provider pointed at the model. |
| control | `control.ts` | A trivial `Bun.serve` answering `{ok:true}`, own process, same nice level. |
| probe | `probe.ts` | Separate process. Every 250 ms: `GET /amicode/ping` on the host (Basic auth) **and** on the control, in the same tick. 2 s without an answer = a miss. |
| sampler | `sampler.ts` | Every 10 s: host `VmRSS`, CPU seconds (`/proc/<pid>/stat`), `/proc/loadavg`; model and control RSS/CPU too. |
| driver | `driver.ts` | N sessions looping prompt → wait for the turn to end → think 1–6 s. 1 global `/api/event` subscriber + one per third of the sessions; ~10 % of subscribers (at least one) abort and reconnect every 2–5 min; session list + info poll every 5 s; its own event-loop drift every 100 ms. |
| — | `summarize.ts` | Applies the pre-registered criteria to the raw files → `summary.json`. |

### Sandbox and safety properties

- Everything lives in `<out>/sbx`: temp `XDG_{STATE,DATA,CONFIG,CACHE}_HOME` and `HOME`, a **fresh database file**, a random
  password in a `0600` file, `OPENCODE_DISABLE_FREE_MODELS=1`, no credentials. The host never sees the real home; the harness
  never reads or writes `~/.amico`, `~/.config/systemd` or `~/.local/share/opencode`, never registers as or talks to the machine's
  opencode service or the hub, and creates no systemd unit itself (you create the transient `amico-h0a-*` one).
- Loopback only, ports **53000–53999** only (`common.ts` `assertPort`; the model and control refuse any other port).
- Every child's pid is written to `pids.json` the moment it starts. Teardown: SIGCONT the host (a stopped process cannot
  handle SIGTERM), then SIGTERM → wait → SIGKILL each child **by that exact pid**, then sweep what remains of the runner's
  own process group/session (again by exact pid; a zombie is ignored), then report anything still alive. It never
  signals by command-line text or cwd, and never `pkill`s. The report is in `final.json` / `summary.json` (`leftovers`); the
  run exits 4 if it is not empty.
- After a run, the operator's leak check (a script that scans the run dir and the repo for stray processes, listeners and files; kept outside this repo) must exit 0.

## Output files (`<out>`)

| File | Content |
|---|---|
| `run.json` | config + `measure_from` / `measure_until` (epoch ms), ports, pids, fault plan |
| `probe.ndjson` | `{t, h, c, hs, cs, pl}` per tick: host ms, control ms (`null` = miss), HTTP statuses (`0` = miss), probe lateness |
| `sampler.ndjson` | `{t, rss, cpu_s, load1, load5, procs:{model,control}}` |
| `turns.ndjson` | `{session, start, end, outcome, via}`; outcome `succeeded|failed|interrupted|lost`; `via` `event|poll|event-late|post_error` |
| `driver-lag.ndjson` | `{t, d}` the driver's own timer drift (ms) |
| `driver-polls.ndjson`, `driver-subscribers.ndjson`, `driver-stats.json` | dashboard-poll latencies; subscriber aborts/reconnects; counters including per-subscriber `frames`, `unplanned_ends`, `seq_gaps` (durable-event gaps seen after a reconnect) |
| `events.ndjson` | lifecycle: `*_started`, `*_exit` (`planned`), `window`, `fault_*`, `teardown_started`, `leftover_check` |
| `model-stats.json`, `final.json`, `pids.json`, `*.log` | model counters; db size + leftovers; pids; child stdout/stderr |
| `summary.json` | the verdict, below |

## Criteria → `summary.json`

`verdict` ∈ `pass | fail | inconclusive | invalid`. Precedence: a definitively failed criterion ⇒ `fail`; else an unusable input ⇒
`invalid`; else a noisy control, a saturated driver, an unplanned exit of a harness process or a window too short for the
extrapolation ⇒ `inconclusive`; else `pass`. **Missing, empty or corrupt input never yields a pass** (`problems` lists it).

| Pre-registered criterion | `criteria[]` entry | Numbers reported | Rule |
|---|---|---|---|
| 1 Latency | `latency` | `host_p99_ms`, `control_p99_ms`, `excess_p99_ms`, p50s, `host_max_ms`, `host_non200_fraction` | p99(host) − p99(control) **< 250 ms** and p99(host) **< 500 ms**; control p99 **> 100 ms** ⇒ `inconclusive`. A miss counts as 2000 ms. |
| 2 No wedge | `no_wedge` | `wedges`, `wedge_events[{start,end,misses}]`, `warmup_wedges`, `unplanned_host_exits`, `missed_ticks` | zero wedges (two consecutive misses = one event, however long) and zero unplanned host exits |
| 3 Memory | `memory` | `growth_bytes`, `slope_bytes_per_hour`, `projected_rss_24h_bytes`, `rss_max_bytes`, `window_s` | RSS growth first→last sample of the window **< 2 GB** and the least-squares projection at 24 h **< 8 GB** |
| 4 Correctness | `turns` | `started`, `succeeded`, `failed`, `interrupted`, `lost`, `completion_rate`, `ended_via_poll` | ≥ 99 % succeeded and **zero** `lost` (a turn with no visible end) |

Also in the summary: `driver_saturated` (+ `driver_p99_drift_ms`; p99 > 50 ms ⇒ `true` ⇒ run is `inconclusive`),
`harness_unplanned_exits`, `host_cpu_seconds`, `load1`, `harness_cost` (model/control CPU), `model_stats`, `driver_stats`.

### Interpretations the note left open (stated here so they are not discovered later)

- **GB is decimal** (2 GB = 2·10⁹ B, 8 GB = 8·10⁹ B): the stricter reading.
- **"Slope extrapolating past 8 GB at 24 h"** = fitted RSS at the end of warm-up + slope × 86 400 s, compared with 8 GB.
  A window under 30 min cannot support that extrapolation: such a run can *fail* memory on growth but not *pass* it (`inconclusive`).
- **A miss** is no answer within 2 s, a connection error, or an answer that took ≥ 2 s. A host that answers errors (>1 % non-200)
  makes latency `inconclusive`, because the latency of an error says nothing.
- `--duration-s` is the measurement window; the warm-up is on top of it (L1: 5 min + 2 h).

## How a turn's end is known

The v2 API has no "wait for the turn" call. The driver listens on the global `/api/event` stream for the session's
`session.execution.succeeded | failed | interrupted`. That stream is **volatile by contract** (a slow consumer is cut off and
events during a disconnection are missed), so a turn with no end event after 45 s is checked by polling `GET /api/session/:id`
(`time.busy` / `time.idle` / `outcome`); after 180 s with no visible end it is recorded as `lost`. The global subscriber is never
deliberately aborted (it is the turn tracker); the reconnect chaos runs on the per-session subscribers.
**Deviation:** the v2 API has no per-session event route, so a "per-session subscriber" is another `/api/event` subscription
(the full firehose) that the driver filters to one session: it loads the host the same way a dashboard watching one session does.

## Tests

```sh
cd docs/spikes/h0a-harness
env -u BUN_INSPECT -u AMICODE_ENGINE_INSPECT bun test                     # unit: ~10 s, ports 53000-53999 only
env -u BUN_INSPECT -u AMICODE_ENGINE_INSPECT H0A_SMOKE=1 bun test smoke.test.ts   # integration: ~3 min, two real runs
```

Unit: percentile, wedge detector (one miss ≠ wedge, two = one event, recovery resets, outages merge), least squares, pacing
(2–8 s on the wire, seeded determinism, request kinds), probe against a live/unauthorised/silent server, `/proc` parsing,
every criterion at its boundary (249 vs 251 ms, control inconclusive, 2 GB, 99 %), refusal on missing/empty/corrupt inputs.
Integration: the 90 s smoke (4 sessions) and the **negative control** (SIGSTOP the host for 3 s → exactly one wedge, run
`fail`), each followed by an independent `/proc` scan of the run directory.

## Limits

Synthetic traffic and a fake model (see the note). The model parses each request body to see whether the last message is a tool
result; with very long sessions that grows (compaction is not exercised). The driver is a single Bun process; if it saturates
(`driver_saturated`) the run is not believed. The probe measures round-trip latency from outside, an upper bound on host
event-loop lag (observability inside the host is #2065).
