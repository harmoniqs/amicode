---
name: detached-run
description: Launch a long solve, scan, or fit in the background so it survives the tool call, is bounded in wall-clock and memory, and can be stopped cleanly (PID file, whole process group, children included). Use for runs the run gate does not cover (Python lanes, reduced-space or custom-driver arms, scans), before trusting a "free memory" number, and whenever a background run must be killed.
agents: [experimenter, engineer]
surface: public
revision: 1
---

# detached-run — bounded background runs you can actually stop

A background run needs four things the raw `nohup cmd &` does not give you: it must **survive the tool call**, it must be **bounded** (wall-clock and memory), it must **leave a handle** (a PID file), and it must be **stoppable without orphaning children**. This card is the launcher and the stop recipe, plus the traps that three experimenter casts in one campaign (fluxonium-cz, 2026-11) re-derived by hand five times.

> **Status: draft, partially verified.** The launcher and stop scripts below were run on a Linux box with a stand-in child (details under *What was verified*). Behaviour of a real Julia/Python child under `timeout` is observed in the campaign but its mechanism is **not** established — see *Unverified*.

## Gate first, this card second

Production solves go through the run gate (`amico run`, see the `solve` card if your session has it): the gate validates the spec, checks the tier, and writes the run record that verification and catalog ingest require. This card is for the work the gate does not cover — and **a result from a run launched this way is UNTRUSTED** until something independent has re-derived it (a lab-frame or full-model re-rollout, a pinned verifier). Never bank or report its numbers as verified on the solver's own say-so.

Reasons a run legitimately lands here (all observed in the fluxonium-cz campaign, 2026-11; re-check against your `amico` version before relying on them):

- The lane is **Python** (Floquet scans, eigensolver sweeps, Modal fan-outs): `amico run` was Julia-only.
- The lane is a **reduced-space / custom-driver arm** with no gate-supported route.
- `amico run` **stripped custom environment variables** (campaign `B1_*` variables vanished; `JULIA_NUM_THREADS` passed), required `--julia <path>` (bare `julia` not found), and **killing the `amico run` parent left the Julia child running**.

If the gate *can* run it, use the gate.

## The launcher

Save as `launch.sh`; it writes `runs/<tag>.{log,pid,start}` under the current directory.

```bash
#!/bin/bash
# launch.sh TAG WALL_S MIN_AVAIL_GIB -- CMD [ARGS...]
set -euo pipefail
tag=$1; wall=$2; need=$3; shift 4            # drops the literal "--"
mkdir -p runs
avail=$(awk '/MemAvailable/ {printf "%d", $2/1048576}' /proc/meminfo)   # GiB; NOT the `free` column
[ "$avail" -ge "$need" ] || { echo "refuse: MemAvailable ${avail} GiB < ${need} GiB" >&2; exit 2; }
[ ! -e runs/$tag.pid ] || { echo "refuse: runs/$tag.pid exists (stop or remove it first)" >&2; exit 2; }
# setsid: new session, survives the caller. bash writes its own PID and then `exec`s, so the recorded PID is the
# final `timeout` process and (as session leader) its PGID == PID. `-k 60`: SIGKILL if SIGTERM is ignored.
setsid nohup bash -c 'echo $$ > "$0"; exec timeout -k 60 "$1" nice -n 10 "${@:2}"' \
  runs/$tag.pid "$wall" "$@" > runs/$tag.log 2>&1 < /dev/null &
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s runs/$tag.pid ] && break; sleep 0.1; done
pid=$(cat runs/$tag.pid)
awk '{print $22}' /proc/$pid/stat > runs/$tag.start      # start time: guards against PID reuse at stop time
echo "launched $tag pid=$pid avail=${avail}GiB log=runs/$tag.log load=$(cut -d' ' -f1 /proc/loadavg)"
```

Typical use: `./launch.sh h2c_far1 5400 24 -- env OMP_NUM_THREADS=1 JULIA_NUM_THREADS=1 julia --project=. arm.jl` — wall-clock 90 min, refuse below 24 GiB available.

Design choices, each of which was a real failure:

- **`setsid` + `nohup` + `< /dev/null`** — a plain `nohup … &` is reaped when a sandboxed tool call returns (see `debugging`, *Background process death*); a new session survives it.
- **The PID is recorded from inside the new session** (`echo $$` then `exec`), not from `$!`. `setsid` forks instead of exec-ing when its caller is a process-group leader (an interactive shell with job control), and then `$!` names a process that has already exited.
- **`timeout -k 60`** — without `-k`, `timeout` sends SIGTERM once and then waits forever on a child that ignores it.
- **`nice -n 10`** — the campaign ran several lanes on one shared box; the launcher yields to interactive work.
- **Refuse, don't warn, on the memory gate and on an existing PID file** — two launches racing on one tag is how a run gets two writers on one log.

Set per-process thread counts yourself when several runs share a box (`OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 JULIA_NUM_THREADS=<n>`); the launcher does not guess.

## The stop recipe

Save as `stop.sh`. It kills **the process group named by a PID file** and nothing else.

```bash
#!/bin/bash
# stop.sh TAG [GRACE_S]
tag=$1; grace=${2:-20}; pid=$(cat runs/$tag.pid)
[ "$(awk '{print $22}' /proc/$pid/stat 2>/dev/null)" = "$(cat runs/$tag.start)" ] || { echo "$tag: not running (or PID reused)"; exit 0; }
kill -TERM -- -$pid
for _ in $(seq "$grace"); do kill -0 -- -$pid 2>/dev/null || { echo "$tag: stopped"; exit 0; }; sleep 1; done
kill -KILL -- -$pid; echo "$tag: killed"
```

Rules that go with it:

- **Kill by recorded PID or PGID only. Never `pkill -f`, `killall <name>`, or a `pgrep`-built kill list.** A shared box runs other people's and other lanes' `julia`/`python`/`timeout` processes; a name match will take them with yours. Record what you launched, kill what you recorded.
- **Kill the group (`kill -- -PID`), not the single PID.** SIGKILL to the `timeout` PID alone leaves its child running, reparented to init (verified below). A group signal also reaches grandchildren (MPI-style workers, `xargs` children, solver subprocesses).
- **Check the start-time stamp before signalling a PID from an old file** — PIDs are reused. The script above does.
- After a stop, **confirm nothing survived** by listing the group (`ps -o pid,pgid,cmd -g <PID>` returns nothing when the group is gone) rather than by name.

## Memory: read MemAvailable, not the `free` column

`free -g` prints `free` and `available` side by side. The `free` column excludes reclaimable page cache; on a box that has been running scans it can be a fraction of what is really usable. Briefs that say "`free -g` ≥ 20 GB" are ambiguous, and in the campaign they were misread both ways:

| cast | `free` column | `available` (= MemAvailable) |
|---|---|---|
| H2c | 19 GB (launched 1 GB under the literal bar) | 26 GB |
| D2a | 4–12 GB at every launch | 23–34 GB |
| B8 | 17–20 GB | 26–33 GB |

Gate on `MemAvailable` from `/proc/meminfo` (the launcher does). Two companions to that gate: budget **peak RSS × the number of concurrent runs**, not one run (one campaign solver measured 34–40 GB resident, so only one could run at a time); and re-check the gate before each launch in a batch, because the first launch's footprint is not yet visible when the second checks.

## Observability and honest timings

- **Stdout redirected to a file is block-buffered** in Julia and in Python: no progress shows until a flush or exit. Flush explicitly in the script (`flush(stdout)`, `print(..., flush=True)`) or the log looks dead while the run is healthy.
- **Timings under load are load-dependent.** One campaign's ledger quoted "≈5 s per point" for an eigensolver step; the production path later measured 36–62 s per point at box load 23–57 on 24 cores. When you record a timing, record the load average beside it (the launcher prints it at launch) and call the number a load-conditioned measurement, not a constant.
- If your session has the `live-solve` skill, register the run on the live widget at launch — runs launched outside the gate are exactly what it mirrors from `runs/<tag>.log`.

## What was verified (and how)

On a Linux box (procps/coreutils `timeout`), with a stand-in child that ignores SIGTERM (`bash -c 'trap "" TERM; exec sleep 60'`) in place of a real solver:

1. The launcher records a PID equal to the `timeout` process's PGID and SID; the child shares the group.
2. `kill -9 <PID>` of the recorded `timeout` process alone **left the child running** under init (reproduces the campaign's "killing the wrapper leaves the Julia child alive" report). Tested on the launcher above and on the campaign's original `setsid nohup timeout … nice …` pattern.
3. `timeout` **without `-k`** left both `timeout` and a SIGTERM-ignoring child alive well past its 2 s limit (original pattern, checked at 4 s).
4. With the launcher's `-k 60` (wall-clock 2 s, SIGTERM-ignoring child): both processes still alive at 10 s, both gone at 65 s. `stop.sh` with a 3 s grace reported "killed" and left no survivor; a group SIGKILL cleared both immediately.
5. The memory gate refused an impossible request (exit 2); a second launch on an existing PID file refused (exit 2); `stop.sh` on a finished run reported "not running".
6. The launched run survived the exit of the shell that started it.

## Unverified

- **Why the real Julia child outlived `timeout`'s SIGTERM** in the campaign (H2c: killed by hand ~200 s after the limit; B11: the child outlived the SIGTERM by about 60 s; a later cast recommended `timeout -k 60`). The stand-in reproduces the *effect* of a child that ignores SIGTERM; whether Julia was blocked inside a long native call or something else is not established. `-k` plus the group kill is the robust answer either way.
- The launcher assumes Linux `/proc` and GNU `timeout`. On macOS there is no `/proc/meminfo` (use `vm_stat`) and no `setsid` by default; adapt before use.
- `amico run` behaviours in *Gate first* are the campaign's observations at the time, not a current spec.

## Provenance

fluxonium-cz research campaign (2026-11-05 … 11-07): friction notes F-fcz-07, 08, 09, 15 and proposal S-fcz-02, drawn from the B1, B6, B7, B8, H2c, D2a, G1 and B11 observation notes (launchers hand-copied five-plus times: setsid / nohup / nice / timeout / PID file / MemAvailable gate). The recipe's behavioural claims are the ones listed under *What was verified*; everything in *Unverified* is labelled as such.

## Related

- `debugging` — *Background process death at harness boundaries* (why `setsid`).
- `prereg-seal` — seal the predictions *before* the scan this card launches.
- `live-solve` — put the run on the home widget (if available in your session).
