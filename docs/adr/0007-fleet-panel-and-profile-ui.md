# Fleet Panel & Profile UI: visual fleet command center in the activity bar

Status: draft (2026-08-12)

The fleet system (ADR 0005) established the multi-machine topology, the session registry
state machine, and the CLI verb surface (`amico fleet list/status/steer/stop/re-tier/sweep`).
All fleet management is CLI-only — no visual surface exists beyond a status bar item that
shows the fleet role and a "Go Standalone" command. The `sessionView()` function in
`fleet_verb.ts` was designed to back a visual dashboard but no panel consumes it. Setting
up a fleet requires SSH-ing into machines and running terminal commands manually — no
guided flow exists.

This ADR introduces a **Fleet panel** — a VS Code native webview in the activity bar
sidebar — that makes the fleet a visible, interactive product surface: a **setup wizard**
(fully automated fleet creation/lifecycle over SSH), topology graph, Fleet Profile CRUD,
session launch, and aggregate monitoring. A follow-on slice enriches the sessions dropdown
with fleet-managed session badges and per-session fleet actions via the chat bridge.

**Why a VS Code native webview (not inside the opencode SolidJS app):** Fleet state lives
entirely on the extension/CLI side — TOML files under `~/.amico/ops/fleet/`, read by
`fleet_registry.ts`. Placing the UI inside the iframe'd opencode app would require either
polluting the opencode server with amicode-specific routes (rebase pain on the upstream
fork) or bridging all fleet data through the chat relay (designed for commands, not streaming
state). The extension host already has the data; `postMessage` to a local webview is the
shortest path. The Device Inspector proves this pattern at production quality.

**Why the activity bar (not the bottom panel):** The fleet panel is a persistent monitoring
surface — you glance at it while working. The bottom panel competes with the terminal and
collapses to a thin strip. The activity bar sidebar is full-height, always accessible when
the Amicode container is focused, and cohabits naturally with Armonia (navigation) and
Catalog (browsing).

**Why a fully automated setup wizard:** Fleet creation currently requires SSH access, manual
file edits on multiple machines, running install scripts, and restarting VS Code. A newbie
who can SSH into their Mac Studio should be able to set up a fleet from a single button
click in the panel — the wizard validates connectivity, configures both machines, installs
services, and validates end-to-end. SSH key-based auth is the only prerequisite the wizard
cannot create (it validates but does not configure SSH keys — that's an OS-level concern).

**Why panel-first, bridge-second (two slices):** The panel is self-contained — extension
reads TOML, pushes to webview, webview posts actions back. It validates the data model and
ships value immediately (topology visibility, profile management, session launch). The
bridge work (pushing fleet state into the opencode app for dropdown badges) touches the
chat_bridge allowlist, the app-side state model, and the iframe relay — riskier, better as
its own deliberate slice.

**Why Fleet Profile as a domain concept:** The fleet registry already carries an inline
`FleetProfile` on each session record. Elevating it to a first-class entity (one TOML file
per profile, CRUD from the panel) means users define "what kind of session to launch" once
and stamp it many times. The alternative — configuring model/skills/permissions at every
launch — is tedious and error-prone for a fleet that runs many orchestrated sessions.

**Why full lifecycle in one slice (create/add/remove/dismantle):** The wizard is useless
without remove (you can't undo mistakes); the graph is useless without setup (nothing to
show). They're one coherent surface — the topology graph IS the lifecycle UI (add machines
via a button, remove via node popovers, dismantle via removing the last node).

**One fleet at a time (explicit constraint):** A machine belongs to at most one fleet —
`fleet.json` declares a single canonical server, not a fleet list. Reconfiguring the
existing fleet (changing host/port/SSH alias) is supported from the panel; creating a second
fleet is not. This keeps the mental model simple (THE fleet, not A fleet) and matches the
single-`fleet.json` storage model. Multi-fleet is deferred indefinitely — the use case
(one researcher, multiple studios) doesn't exist today.

**Why remote host settings in the panel:** If your Mac Studio is the canonical server, you
need to configure it (database path, port, binary, logs) without SSH-ing in by hand. The
panel already has SSH access (from the setup wizard) — reusing it for settings read/write is
natural. Changes that require a server restart show an indicator and offer one-click restart
(stop + start the launchd service remotely). When the current machine IS the server,
settings are local — no SSH needed.

**Conditions of merge:** the setup wizard creates a working fleet from standalone in one
flow (validates SSH, configures remote + local, starts server, validates tunnel); add/remove
machines work post-setup; the panel renders the topology graph (SVG, hand-positioned star
topology) with node popovers; profiles are round-trippable (create in panel → TOML on disk
→ load → edit → save); launch from the panel spools a fleet-managed session visible in the
sessions dropdown; aggregate stats update within 1s of a record change. Tests: wizard SSH
mock (validates the full flow without a real remote), fleet_panel host tests (message
protocol), profile TOML round-trip, graph rendering snapshot.

**Flip condition:** if the opencode upstream gains a native plugin/panel API that lets
extensions inject UI into the app without iframe bridging, reconsider moving the Fleet view
into the app for a unified experience. Until then, native webview is correct.

**Accepted costs:** a third view in the activity bar container (acceptable density — the
views collapse individually); vanilla TS DOM composition instead of SolidJS (consistent with
Run Inspector and Device Inspector, not a regression); SSH automation in the extension host
(Node.js `child_process` with `ssh` commands — no external SSH library); the follow-on
bridge slice adds two message types to the chat_bridge allowlist (low risk, well-isolated).

**Considered:** Fleet panel inside the opencode SolidJS app (rejected — data bridging
problem, upstream pollution); bottom panel placement (rejected — competes with terminal,
wrong interaction density); tree view instead of webview (rejected — state machines,
graphs, and action buttons don't fit tree nodes); full vertical delivery of both slices
(rejected — larger blast radius, bridge risk bundled with panel work); CLI-only setup
permanently (rejected — not intuitive for newbies, the panel should be the primary setup
surface); guided checklist (user runs commands) instead of full automation (rejected — still
requires terminal knowledge, half-measure).

**Prior art / source:** Device Inspector (the structural template); `fleet_verb.ts`
`sessionView()` (designed to back this panel); ADR 0005 (the fleet system this panel
surfaces); `tools/fleet/install.sh` (the CLI installer the wizard automates); the Context
tab's graph in the opencode app (visual precedent for the topology graph).
