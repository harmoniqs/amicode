# Fleet Panel & Profile UI: visual fleet command center in the activity bar

Status: draft (2026-08-12)

The fleet system (ADR 0005) established the multi-machine topology, the session registry
state machine, and the CLI verb surface (`amico fleet list/status/steer/stop/re-tier/sweep`).
All fleet management is CLI-only — no visual surface exists beyond a status bar item that
shows the fleet role and a "Go Standalone" command. The `sessionView()` function in
`fleet_verb.ts` was designed to back a visual dashboard but no panel consumes it.

This ADR introduces a **Fleet panel** — a VS Code native webview in the activity bar
sidebar — that makes the fleet a visible, interactive product surface: topology graph,
Fleet Profile CRUD, session launch, and aggregate monitoring. A follow-on slice enriches
the sessions dropdown with fleet-managed session badges and per-session fleet actions via
the chat bridge.

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

**Conditions of merge:** the panel renders the topology graph (SVG, hand-positioned star
topology) with node popovers; profiles are round-trippable (create in panel → TOML on disk
→ load → edit → save); launch from the panel spools a fleet-managed session visible in the
sessions dropdown; the status bar item click focuses the Fleet panel; aggregate stats
(active sessions, tokens today) update within 1s of a record change. Tests: fleet_panel
host tests (message protocol), profile TOML round-trip, graph rendering snapshot.

**Flip condition:** if the opencode upstream gains a native plugin/panel API that lets
extensions inject UI into the app without iframe bridging, reconsider moving the Fleet view
into the app for a unified experience. Until then, native webview is correct.

**Accepted costs:** a third view in the activity bar container (acceptable density — the
views collapse individually); vanilla TS DOM composition instead of SolidJS (consistent with
Run Inspector and Device Inspector, not a regression); the follow-on bridge slice adds two
message types to the chat_bridge allowlist (low risk, well-isolated).

**Considered:** Fleet panel inside the opencode SolidJS app (rejected — data bridging
problem, upstream pollution); bottom panel placement (rejected — competes with terminal,
wrong interaction density); tree view instead of webview (rejected — state machines,
graphs, and action buttons don't fit tree nodes); full vertical delivery of both slices
(rejected — larger blast radius, bridge risk bundled with panel work).

**Prior art / source:** Device Inspector (the structural template); `fleet_verb.ts`
`sessionView()` (designed to back this panel); ADR 0005 (the fleet system this panel
surfaces); the Context tab's graph in the opencode app (visual precedent for the topology
graph).
