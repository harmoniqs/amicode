---
type: spec
schema_version: "1"
spec_id: spec-20260914-205414-daemonize-standalone-server
task_type: implement-slice
parent_issue: 1142
feature_branch: jj/1142-server-survives-reload
acceptance:
  - daemon_reparented_off_spawner == 1
  - daemon_survives_spawner_exit == 1
  - handshake_records_server_pid == 1
  - adopts_surviving_daemon == 1
  - stop_terminates_daemon == 1
  - stop_before_pid_known_frees_port == 1
  - health_gate_blocks_until_ready == 1
  - targeted_suites_pass == 1
  - typecheck_clean == 1
invariants:
  - the server is spawned loopback-only with the injected OPENCODE_SERVER_PASSWORD — the daemonizer adds no new network exposure
  - a foreign process holding the port is never killed — the #1178 reclaim discipline (ours-only, verify-freed) is preserved verbatim, including in the by-port stop() fallback (D6)
  - the PID persisted in the handshake, checked by the adopt gate, and killed by stop() is ALWAYS the opencode server's PID (the reparented grandchild) — the intermediate launcher's PID is never persisted, never adopted, never killed
  - the daemonizer uses a Node intermediate (process.execPath + ELECTRON_RUN_AS_NODE), never a `setsid` shell binary, so it holds on macOS and the linux-x64/arm64/WSL release targets
  - the CI harness runs under plain `node` and proves the POSIX double-fork mechanism ONLY — the Electron-as-node launcher wrapper that ships is exercised solely by the human reload test; the launcher command string gets a construction smoke check, but Electron-as-node reparenting is not machine-proven in this slice
  - _ready and url are invalidated by the health/keepalive path, never by a child-exit event (there is no owned handle to emit one) — a crashed daemon must not read as ready
  - the true end-to-end proof — an in-flight turn surviving a real VS Code window reload — is human-gated (one Cmd+R after deploy) and is NOT claimed by any machine gate in this slice
baseline: { value: "0% survival — server reaped on every window reload", source: "live Phase-2 test 2026-09-15: survivor pid 26497 dead after Cmd+R; handshake rotated to cold-spawn 29435; confirmed setsid (pgid==pid) yet reaped → PID-tree kill" }
---

# Daemonize the standalone server so it survives a VS Code window reload

## Context

#1142 keeps the standalone opencode server alive across a VS Code window reload so
an in-flight agent turn continues while the extension reloads with new code. All six
original slices (#1144–#1149) plus the wiring fixes (#1178, #1181) landed on
`jj/1142-server-survives-reload`, and Phase-1 is verified: cold-spawn writes a valid
`0600` handshake and the adopt gate's preconditions all pass.

**Phase-2 (the actual reload) failed.** Live test 2026-09-15: the survivor `26497`
was dead after a plain Cmd+R; the handshake was rotated (cold-spawn `29435`), meaning
the new window found `pidAlive == false` and cold-spawned. Forensics established that
our code did not kill it (`deactivate()`→`detach()` never kills; kill-by-port runs only
on the no-handshake path; keepalive only deletes the handshake). The server is spawned
`detached:true` + `unref()` + stdio→file — the textbook recipe — and confirmed to be in
its **own process group** (`pgid==pid`), yet it still died. Therefore VS Code reaps by
**PID-tree / recorded-PID**, which a process-group detach does not escape.

A same-machine proof (safe, no ports) showed the fix: while a mock parent stayed alive,
a single-fork child kept `PPID==parent` (inside the reaped subtree) while a **double-fork
grandchild reparented to `PPID==1` immediately** (outside the subtree). Removing the
server from the ext-host process subtree — not detaching harder — is the fix.

## Decisions

- **D1 — Double-fork daemonize.** `ServerManager` (log-file path) spawns an intermediate
  launcher `detached`; the launcher spawns `opencode serve …` `detached` and exits
  immediately, so the server reparents to init/launchd (`PPID==1`) before any reload.
  The launcher is a Node intermediate run via `process.execPath` with
  `ELECTRON_RUN_AS_NODE=1` (portable; no `setsid` binary).
- **D2 — PID by discovery, not by report.** After the port passes health, the server's
  PID is obtained from the listener via the existing #1178 `pidHoldingPort(port)` (lsof)
  primitive. This is the PID written to the handshake. The launcher's PID is never
  persisted. Rationale: the listener PID is provably the server; a launcher-reported PID
  could be the (already-exited) launcher — the exact "reads a field whose value is wrong"
  defect this codebase keeps hitting.
- **D3 — Stop by PID.** With no owned `ChildProcess` handle, `stop()` terminates the
  server by its discovered PID (SIGTERM→SIGKILL, verify-gone), reusing the #1178
  kill-and-verify primitive. `detach()` becomes trivially correct: nothing to detach —
  the server is already `PPID==1`; `detach()` only stops the log tailer.
- **D4 — Loss of the child-exit event is covered.** Without a handle there is no
  `child.on("exit")`. Server-gone detection already lives in the keepalive path
  (`server_keepalive.ts` deletes the handshake when pings stop answering); no new
  mechanism is added.
- **D5 — Public contract unchanged.** `ServerManager` keeps `start()/stop()/detach()/
  onReady/url`; only the internals change from "own a child handle" to "daemonize →
  discover PID → kill by PID". D5 means the *observable behavior* is unchanged (stop()
  terminates the server and resolves once it is gone); the implementation changes. The
  legacy piped path (no logFile, used by tests) is retained unchanged for backward compat.
- **D6 — stop() has a by-port fallback.** When stop() is called before the PID has been
  discovered (server spawned, health not yet passed) or on a start() health-failure,
  there is no server PID to kill. stop() then falls back to freeing the PORT via the
  #1178 kill-and-verify primitive, which kills ONLY when the holder is our opencode
  server (`isOpencodeServer`) and never a foreign process. This is the same discipline
  that guards the reclaim path.
- **D7 — PID discovery, primary + fallback.** Primary: `pidHoldingPort(port)` (lsof) after
  health — the listener is provably the server, and the launcher (which never binds the
  port and has already exited) can never be returned. Fallback for lsof-absent minimal
  containers: the launcher writes the SERVER's PID (its own detached child's pid, which it
  knows) to a pidfile beside the handshake; the extension reads it after health. The
  pidfile holds the server pid, so the "launcher PID is never persisted" invariant holds.
  The two must agree when both are available; the lsof listener wins on disagreement.

## Measurement Protocol

A real-process harness (Node, ephemeral — no port 43117, no VS Code), runnable on the
CI Linux runner and locally on macOS, establishes the machine-checked criteria:

- `daemon_reparented_off_spawner == 1` — after a daemonized spawn, the server's PPID is
  neither the ServerManager-spawning process nor the intermediate launcher (both known
  pids). On macOS and a plain Linux runner this is `PPID==1`; under a Linux child-subreaper
  it is the subreaper — still off the spawner. The portable assertion is `ppid(server) ∉
  {spawnerPid, launcherPid}`, which is what defeats the ext-host subtree reap.
- `daemon_survives_spawner_exit == 1` — the spawning process exits; the server PID is
  still alive afterward (1 = alive).
- `handshake_records_server_pid == 1` — the handshake written on daemonized spawn records
  the **listener's** PID (== `pidHoldingPort(port)`), and `isPidAlive(recorded)` is true.
- `adopts_surviving_daemon == 1` — after the spawner exits, `adoptOrSpawn(handshakePath,
  liveDeps)` against the surviving daemon returns `outcome == "adopted"` (1 = adopted).
  This is the strongest automatable proxy for survive-reload: a real daemon, the real
  gate, the real adopt path.
- `stop_terminates_daemon == 1` — `stop()` on a daemonized server (PID known) leaves the
  PID gone.
- `stop_before_pid_known_frees_port == 1` — `stop()` invoked before health/PID-discovery
  frees the port via the D6 by-port fallback (port has no listener afterward), and does
  not kill a foreign holder (harness plants a non-opencode listener and asserts it lives).
- `health_gate_blocks_until_ready == 1` — `start()` does not fire `onReady`/write the
  handshake until the port answers health (guards the extension side of the "not ready"
  race).
- `targeted_suites_pass == 1` — the mocked/injected vitest suites (server_manager,
  server_lifecycle, server_handshake, server_teardown, cold_spawn_handshake, overlay_cache,
  and the new daemonize suite) pass.
- `typecheck_clean == 1` — `tsc` is clean.

The harness kills every process it spawns on teardown and binds no fixed port. It NEVER
touches the live session's server (port 43117) or the live handshake.

## Non-goals

- Automating the real VS Code window-reload survival (human-gated; one Cmd+R post-deploy).
- The engine-side `/keepalive` self-shutdown route (deferred in #1147; unchanged here).
- Any change to the adopt gate's four checks, the #1178 teardown, or #1181 activation
  wiring beyond passing the discovered PID and the by-PID stop.

## Review (by hand — tooling=manual, `amico spec review` absent on this repo)

No automated critic ran. Three independent lenses were applied by hand — a weaker claim
than tool-run, perspective-isolated critics, and recorded as such. No blocking
contradiction found (no two spec lines that cannot both be true). All findings are
advisories, resolved into the spec (round 2) or carried as plan obligations.

- **Lens A — cross-module vocabulary (the recurring "reads a field its schema doesn't
  carry" defect).** The PID must be the server's across {handshake write, adopt
  `pidAlive`, stop kill}. Resolved: D7 (discover the listener via lsof post-health; pidfile
  fallback holds the server pid, never the launcher's) + the explicit invariant. D5 wording
  clarified: "contract unchanged" = observable behavior, not implementation.
- **Lens B — portability (CI Linux + WSL, not just macOS).** (B1, severe) `daemon_ppid ==
  1` is fragile under a Linux child-subreaper → relaxed to `daemon_reparented_off_spawner`
  (ppid ∉ {spawner, launcher}). (B2) the CI harness proves the POSIX double-fork under
  plain node only; the Electron-as-node wrapper is human-reload-verified — stated as an
  invariant + a launcher-command construction smoke check. (B3) lsof-absent → D7 pidfile
  fallback.
- **Lens C — regression / #1178 orphan safety.** (C1) stop() before PID-discovery / on
  health-fail → D6 by-port fallback + new criterion `stop_before_pid_known_frees_port`.
  (C2) the by-port fallback keeps the ours-only kill discipline (foreign holder untouched)
  — folded into D6 + the invariant + the criterion's foreign-holder assertion. (C3)
  _ready/url driven by health/keepalive, not a child-exit event — stated as an invariant.

Verdict: **approved-mechanical (by hand)** — tier 1 clean, three lenses applied manually,
all advisories resolved or tracked. Not equivalent to tool-run `approved`. Round 2.
