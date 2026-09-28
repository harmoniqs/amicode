# The detached engine is controllable from the app — adopt-safe restart, fleet-aware self-shutdown, a UI power toggle

Status: proposed (2026-09-27)

ADR 0020 made the standalone server survive an editor reload by spawning it **detached** and
**adopting** it on the next activation, and it decided — but the vendored engine never shipped —
a self-shutdown timer driven by an authenticated `/keepalive`. Living with that detached engine
surfaced three gaps 0020 did not close: the **deliberate kills it promised do not work on an
adopted window**, its **self-shutdown was never wired**, and there is **no control surface for
the engine inside the app** even though the app now outlives it. This ADR records the decisions
that close those gaps. It **amends ADR 0020**.

**The defect 0020 did not foresee (adopt-safe deliberate kills).** ADR 0020 names Restart and
Stop as "the two deliberate kills," but the extension constructs its `ServerManager` only on the
**cold-spawn** path. On the **adopted** path — every second window, and every window reload after
the first spawn — the manager is never built, so `amicode.restartServer` / `amicode.stopServer`
call it as no-ops: the running engine is never killed, yet the handshake is deleted and the
status cleared, breaking the session and stranding an orphan that the next reload cold-spawns a
rival beside. **The decision:** the adopted path **seeds** a `ServerManager` from the handshake
record (PID, port) in an "already-running daemonized server" state, so `stop()` kills by the
recorded PID and frees the port (its daemonized branch already does exactly this) and `start()`
respawns onto the freed port. The cold-spawn `onReady` wiring (SSE connect, keepalive, status,
first-ready chat open) is extracted into one function both boot paths and every subsequent
restart share. This is a **defect fix against 0020's stated intent**, not a new policy — the
policy ("Restart and Stop are the deliberate kills") is 0020's.

**Fleet-aware self-shutdown (amends 0020's active-work pin).** ADR 0020's self-exit fires when
the grace window (default 30 s, `amicode.server.graceSeconds`) elapses with no re-adoption and a
zero **active-work pin**, which it defined as "zero in-flight agent turns," with multi-window
liveness carried by keepalive pings from live windows. That definition strands one case: a
**fleet client** using the engine over the SSH tunnel does not send keepalive pings — it holds an
`/event` subscription. **The decision:** the engine's idle predicate gains a third clause — self-
exit only when (grace elapsed since last ping) **and** (in-flight turns == 0) **and** (active
`/event` subscribers == 0). The local extension's own subscription and pings both fall away
together on quit, so "zero subscribers" cleanly distinguishes *nobody is using this* from *a
remote client is streaming*. A `server`/`hub` fleet role is exempt from the timer **entirely**,
set at spawn via `AMICO_ENGINE_NO_SELF_SHUTDOWN=1` (the exemption cannot depend on runtime pings,
because after a quit there are none) — consistent with 0020's boundary that "fleet `server` /
`client` keep the Canonical Server unchanged."

**The engine is controlled from the app UI, not from the engine (the new contract).** With the
app shell served by the extension-host **amicode service** (it survives engine restarts and has a
reconnect UX) and a bridge allowlist that already carries `amicode.restartServer`, the natural
home for a power control is the app's own status cluster. **The decision:** a purpose-built engine
on/off **toggle** lives in the app status popover, with a deliberate split — its **state**
(`on` / `booting` / `off`) is **pushed from the extension** over `postToWebview`, and its
**action** is **routed through the bridge** to `amicode.stopServer` / `amicode.restartServer`.
Two explicit *no*s make the contract: it does **not** derive engine state from the engine's own
`/mcp` (which 503s exactly when the engine is down — the moment the control must stay truthful),
and it does **not** overload the existing **MCP tool-pack toggle** (`amicode` / `slack`), which
enables/disables a tool subprocess the engine hosts, a different thing at a different layer. The
toggle is hidden on fleet-client windows (no local engine to power) and locked while `booting`.

**Alternatives considered.** *Kill-on-deactivate instead of adopt + self-shutdown* — rejected: it
pays a cold-spawn on every reload and breaks the multi-window / fleet sharing 0020 exists to
enable. *Reuse the MCP tool-pack toggle as the engine switch* — rejected: it is engine-backed
(503s when the engine is down, so it cannot power the engine back on), and it means "disable a
tool pack," a semantic collision at the wrong layer. *A native VS Code status-bar toggle* —
viable and smaller (extension-only, trivially outlives the engine), rejected only because the
control was wanted **in the app UI**; kept on the shelf as the fallback if the app-bundle surface
proves too costly to maintain. *Keep `restartAdoptedEngine`'s window-reload as the adopted-restart
path* — rejected for the toggle's purposes: a full extension-host reload is too heavy for a power
button, and the seeded manager makes in-place restart possible; the reload path stays for the
stale-engine / build-mismatch case, which genuinely wants a fresh window.

**Accepted costs.** The engine gains the `/keepalive` route + self-shutdown timer 0020 already
booked (a `build:binary`), plus a boot-time read of one env flag. The app bundle gains a status-
popover section and two new message kinds (`engine-state` down, a command post up), so the toggle
slice requires an app-bundle rebuild and rides the `amicode-design-system` tokens. The bridge
allowlist grows by exactly one command (`amicode.stopServer`; `restartServer` is already present).
The `Amicode: Quit` command (stop engine + close window) inherits 0020/Stop's coarse in-flight
proxy and does **not** yet detect *other* windows sharing the engine — an honest limitation;
killing the engine there would disrupt them, while the fleet-aware self-shutdown above protects
the *unattended* case correctly. Per-window multi-tenant detection is left to a later revisit.

**Relation to prior decisions.** **Amends ADR 0020** (standalone server survives reload):
completes its unshipped `/keepalive` self-shutdown, widens its active-work pin with the `/event`-
subscriber clause, and honors its Restart/Stop intent on the adopted path. Inherits 0020's
amendment of **ADR 0002** (the at-rest per-boot password the seeded manager reuses on adopt) and
its boundary against **ADR 0005** (the fleet Canonical Server is unchanged; the role exemption
keeps the two distinct). Touches the bridge surface 0018's Rebuild flow also uses, without
changing Rebuild.

**Flip condition.** Revisit the UI-routed toggle toward the shelved native status-bar item if the
app-bundle control proves too costly to keep in sync across engine/app rebuilds. Revisit the
Quit command's in-flight proxy toward true multi-window/subscriber accounting if sharing one
engine across windows becomes common enough that a mistaken kill is a real hazard.

Implementation: harmoniqs/amicode#1594
