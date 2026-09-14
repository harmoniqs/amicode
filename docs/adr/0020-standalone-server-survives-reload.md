# The standalone server survives an editor reload — detached spawn, adopt-on-handshake

Status: proposed (2026-09-14)

A developer rebuilding amicode (the settings Rebuild buttons or the `scripts/` bash
rebuilds) reloads the VS Code window to pick up new extension code, and today that reload
kills the chat server: it is a plain, non-detached child of the extension host
(`server_manager.ts:73`), deliberately SIGTERM→SIGKILLed on `deactivate()`
(`extension.ts:2251` → `server_manager.ts:109`), so a window reload kills-and-respawns it.
Chat transcripts (SQLite `opencode.db`) and Julia Runs (detached `amico-run`) already
survive that, but an **in-flight agent turn** — a `research`/`develop` campaign mid-generation
or mid-tool-loop, living in server memory — dies with the process. This ADR records the
decision to make a reload non-destructive to the standalone server so those turns keep
running in the background.

**The decision.** The standalone server is spawned **detached** (`detached: true` +
`unref`, stdio redirected to a log file rather than the disposable OutputChannel), so it
reparents to `launchd`/init when the extension host tears down. `deactivate()` **no longer
kills it** — it detaches (disposes the SSE client and log-tail, stops the keepalive) and
leaves the process running. The next activation reads a **Server handshake** record and,
if an adoption gate passes, **adopts** the live server instead of spawning a new one. A
detached server self-exits only when a **grace window** (default 30 s, configurable via
`amicode.server.graceSeconds`) elapses with no re-adoption **and** no **active-work pin**
(zero in-flight agent turns) — the one foundational change to the
vendored engine: a self-shutdown timer driven by an authenticated `/keepalive` the extension
pings while alive.

**Why this shape, and why it is smaller than it looks.** The engine already runs each turn
as a forked server-side fiber that a client disconnect cannot abort — only an explicit
`/abort` stops it (`runner.ts` `Effect.forkIn(scope)`; the prompt route forks and returns
`NoContent`) — and it persists in-flight turn state durably to SQLite as it streams, with
the webview re-hydrating and tailing on reconnect. So turns are *already* survivable across
a client disconnect; the only thing that ends them is the process dying. The entire feature
therefore reduces to keeping the process alive across a reload and reconnecting to it — no
turn-checkpointing, no resume protocol. The requirement is deliberately narrow: survive an
extension-host teardown *within a machine session*, not "headless across reboots for N
machines" (which is what earns the Canonical Server its launchd service, ADR 0005).

**Scope, stated as the honest boundary.** Survival is guaranteed for **extension / app-UI
rebuilds**, where the engine binary is untouched: the server keeps running, the reload loads
new extension code, adoption reconnects, turns survive. Anything the server was *spawned
with* — the engine binary **or** the `buildOpencodeConfigContent` output (staged skills,
instructions, MCP) — only applies on a deliberate restart; a rebuilt binary cannot run inside
an already-running turn, and pretending otherwise would be a lie. Adoption detects this via a
`binaryHash`/`configHash` mismatch and surfaces a non-blocking **stale-engine** notice with a
**Restart engine** action that is gated — it warns when in-flight turns exist before stopping
and cold-spawning on the new build. **Restart** and an explicit **Stop** are the two
*deliberate* kills (Restart swaps the build; Stop shuts the server down); both warn when turns
are in flight, and the grace-window self-exit is the only *non-deliberate* stop. This is
standalone `Server mode` only; fleet `server`/`client` keep the Canonical Server unchanged.

**The handshake and its at-rest secret (this amends ADR 0002).** Adoption needs the
re-activating extension to authenticate to the surviving server, so the per-boot server
password — which ADR 0002 made ephemeral and in-memory-only — is now **persisted** in a
`0600` handshake file at `~/.amico/ops/server/standalone.json` (port, PID, `startedAt`,
password, `binaryHash`, `configHash`, `protocolVersion`), rotated on every cold spawn and
reused only on adopt. This is a real amendment to ADR 0002's threat model, mitigated exactly
as ADR 0005's Fleet token is (loopback-only binding, `0600`, rotation on genuine spawn).
Adoption is refused unless four checks all pass — health `200`, PID alive, password
challenge, and protocol compatible (exact `protocolVersion` match) — so a foreign or dead
process on port `43117` is never adopted (and never killed — it is not ours; we surface an
actionable error instead). The keepalive is a machine-wide liveness signal refreshed by any
live window, so closing one window while another is open keeps the server alive; one server
per machine on the fixed port, consistent with the Canonical Server's "only one" invariant
scoped to standalone.

**Alternatives considered.** *Promote the standalone server to a launchd service* like the
Canonical Server — rejected: it over-serves a survive-a-reload requirement with a
per-platform installer and blurs the `standalone`/`server` mode boundary the glossary draws.
*Keep the password out of a plaintext file via VS Code `SecretStorage`* — rejected: the
Amicode terminal's `opencode`/`amico` CLIs (which get the password via env at spawn) cannot
discover the surviving server from an extension-only secret store; a `0600` file is
universally readable. *Re-key the surviving server on adopt* (mint a fresh password, push it
to a re-key route) — rejected: needs a new authenticated engine route and a re-key handshake
for no threat-model gain over a rotated at-rest secret. *Interrupt the turn and auto-resume
it* (no surviving process) — rejected: the engine cannot cleanly resume a killed turn, and
the verification proved it does not need to; keeping the process alive is strictly simpler
and lossless. *Recycle-on-next-launch with no self-shutdown enforcer* — rejected: an idle
server would linger between a genuine quit and the next launch, which does not honor the
grace-expiry shutdown; the engine authoritatively knows its turn count and is the right
place to enforce it.

**Accepted costs.** The per-boot password becomes an at-rest secret (above). We own stdio
redirection (server logs go to a file we tail into the OutputChannel) and orphan cleanup
(stale/foreign handshake classification on activation). One foundational change lands in the
vendored engine — the self-shutdown timer + `/keepalive` route — so that slice requires a
`build:binary`. A webview reconnecting **mid-text-block** briefly sees that one block catch
up when `text-end` lands a durable part, because fine-grained streaming text deltas are
non-durable; tool calls, step boundaries, and message status are all durable, so the turn
reads as continuing rather than lost.

**Relation to prior decisions.** Amends **ADR 0002** (server-route seam / per-boot password —
now persisted at rest for adoption). Relates to **ADR 0005** (Managed Fleet — this is the
standalone sibling of the headless Canonical Server, a detached child rather than a launchd
service, single-machine rather than fleet; ADR 0005 explicitly rejected an editor-owned
canonical server, and this design keeps the two distinct). Relates to **ADR 0018** (Rebuild
button semantics): the Rebuild handler's build-then-reload flow (in the chat bridge) is
unchanged, but this ADR adds a property 0018 never addressed — the reload it triggers is now
non-fatal to the server — plus the stale-engine restart UX, and skips `build:binary` when the
overlay tree is unchanged so an extension-only rebuild neither slows down nor spuriously flips
the engine hash.

**Flip condition.** Revisit toward a launchd-managed standalone service if "survive across a
full OS reboot / no editor ever open" becomes a standalone requirement (today that is the
fleet `server` mode's job). Revisit the at-rest password if opencode upstream gains a native
adopt-with-identity capability we would rather adopt than maintain.

Implementation: harmoniqs/amicode#1142
