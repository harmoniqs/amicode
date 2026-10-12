# ADR 0031 — Fleet Studio: in-window, multi-machine sessions and workspaces

- **Status:** proposed (review: manual adversarial critics — `amico spec review` tooling absent on this machine; see the design-of-record PRD for the recorded review round)
- **Date:** 2026-09-22
- **Context refs:** ADR 0023 (one-parser projection), ADR 0024 (pluggable transport),
  ADR 0025 (Remote-SSH default posture / thin-client lifeboat — **reframed here**),
  ADR 0026 (host-owned roster; read-only fleet section — **amended here**),
  ADR 0027 (peer fleet studios & compute federation — its **multi-target non-goal is
  reversed here**, its §7 event-relay seam is **consumed here**),
  ADR 0029 (unified serving capability), ADR 0030 (connect-to-fleet-device Quick Pick —
  **superseded here**), ADR 0032 (peer-trust credential — the trust substrate this rides on).

## Context

The fleet today is a set of machines you **switch between**, not a studio you work
*across*. Clicking a device (ADR 0030) shows a Quick Pick — "View sessions on X
remotely?" — whose two options both **swap the whole window** at the target: Thin
Client re-attaches the panel and reloads; Remote-SSH opens a new window. The app reads
sessions from a **single** server connection, so you see one machine's sessions at a
time, and a `Session.Info` record carries **no machine identity** — nothing says where a
session runs.

JJ's own fleet is two **`serving`-capable** machines (a MacBook and a Mac Studio) —
exactly one of which is the keeper / Canonical Server at any time, per ADR 0029's model
(`serving` is a many-valued capability; the keeper is one). The researcher wants what the
product name already implies: **one window that sees and drives every session and workspace
across the fleet, as if local** — watch a solve run on the Studio while chatting on the
MacBook, open any machine's session in place, and always be able to tell which machine a
session belongs to. (Session interaction is orthogonal to serving topology: a machine need
only be reachable and hold a live engine, not be *the* Canonical Server.)

This is the multi-target line ADR 0027 drew with its single, single-target attachment
pointer, and that ADR 0030 named as a non-goal ("Multi-target attachment … rejected for
now", ADR 0030 §Non-goals). This ADR decides to build the Horizon-1-usable core of it now.

## Decision

### §D1 — Multi-target, both live: a session-aware multiplexing proxy + SSE relay

The local `amicode_service` becomes a **session-aware multiplexer**. Each *session-scoped*
request — messages, prompt submit, tool-permission responses, the engine `file` API, and
the SSE subscription — routes to the **machine that owns that session**, resolved by a
session→machine map (from the §D2 fan-out). Concurrent per-peer SSE streams are **merged
into the one event stream** the app consumes, each event tagged with its originating
session id (ADR 0027 §7's event-relay seam, made live). The app keeps talking to its
**single local origin** — the native multi-origin switcher stays rejected for the data
plane (ADR 0027), because credential translation, CSP, and the accept-set (ADR 0032) all
depend on the single-origin model.

Multiple sessions from multiple machines are interactive **simultaneously**. This
supersedes ADR 0027's multi-target non-goal for *interaction*; it does **not** introduce
multi-target *attachment* of the whole panel — the single attachment pointer is retired
for session routing (routing is now per-session, not one global pointer).

The single-origin invariant is **purchased by** this multiplexer: because the app cannot
itself tell a session on machine A from one on B (they share one origin), *all*
cross-machine correctness lives in the service's per-session routing — which is only as
sound as §D1a.

### §D1a — The session→owner routing key (the load-bearing mechanism)

The engine `file` API (`file.read` / `file.write` / `file.status`) — which the Preview tab
and Files-changed use (§D7) — **carries no session id** in its request, and today's
resolver routes by URL **path** to a **single** target (`/amicode/fleet*` → local,
`/amicode/roster*` → keeper, everything else → the one attached pointer). So "routes to the
owner" is **not free** and is **not** "the same plane the agent uses" without new work — a
path-only `file.write` from two open remote sessions would hit the *same* single target.

Decision: every session-scoped request must carry an **explicit owner key**, resolved as
follows.

1. **Session-pathed requests** (`/session/<id>/…`, prompt submit, permission replies) — the
   owner is looked up in the session→machine map by the id already in the path; a map miss
   triggers an on-demand fan-out refresh before routing.
2. **Path-less engine requests** (`file.read`/`file.write`/`file.status`) — the app **must
   attach the active session's owner `machine_id`** as a routing header/param, sourced from
   the Work Column's bound session (the Work Column is session-scoped; it knows its owner).
   The service's resolver is **extended** from the single path-only pointer to a per-request
   owner lookup keyed on that header. Absent the header, the request resolves **local**
   (fail-safe), never to an arbitrary attached target.

Both legs — the engine router's key extraction and the app SDK call sites (the Preview
`serverSDK` write in particular, which today carries **neither** a session id **nor** a
directory) — are real changes and are explicit acceptance criteria of the multiplexer slice
(PRD slice 3), not an assumed property of the existing plane.

### §D2 — Fleet-wide session list, machine-badged, decoupled from focus

A **session fan-out** reads `GET /session` from every `serving` roster peer over the
heartbeat transport idiom (SSH `ssh <alias> curl <loopback>` / HTTPS `peer_origin`),
authenticated with that peer's peer token (ADR 0032), and tags each session with
`{ owner machine, directory }`. The app's session surfaces (the titlebar Sessions dropdown
and the Chats rail) render the **fleet-wide** list, each row **badged by machine**. Session
ids are globally unique, so merge-and-badge is safe (unlike folder-named surfaces — §D4).
The list is **decoupled from the sidebar focus** (§D4): it always shows all machines, so
cross-machine monitoring survives; a separate, optional per-machine **filter** is offered.

### §D3 — Home base local; only sessions and their files are fleet-routed

Identity and knowledge stay on **this** machine, always: the researcher profile, the vault
mounts, the Library. Only a **session's runtime** (its agent, tools, `cwd`) and its
**Work Column** (Files-changed, Preview, Context tree — which describe where it actually
runs) follow the owning machine. Mental model: *"my window, remote-controlling agents that
live on other machines."* A remote session's Files-changed reflects the **owner's**
filesystem while the Vault panel reflects **yours** — those can legitimately disagree, and
that is correct, not a bug.

### §D4 — Focused machine: the sidebar working-surface selector

A new UI concept, the **focused machine**, governs the *working* surfaces. The FLEET
sidebar section becomes a single-select **focus selector** (default: this machine).
Research, Development, and the Workspace browser show **only the focused machine's** roots.
Focus is set by clicking a device in FLEET **or** by focusing a session tab (→ that
session's owner, with the session's folder revealed in the now-focused view). A
**project-roots fan-out** lets each machine report its Research/Dev roots so the sidebar
can render a remote machine's projects. Collisions (two machines with an `amicode` repo)
never arise: only one machine's roots are shown at a time, and the focus header names it.

This **amends ADR 0026**: the fleet section gains a navigation/focus action. It writes **no
roster row** — ADR 0026's read-only-roster invariant holds; focus is a UI selection, not a
roster mutation. Working-surface focus is distinct from, and never re-homes, the local
identity/knowledge of §D3.

### §D5 — Fleet-wide workspace browser via `amico-host://<machine>`

The `amico-host://` FileSystemProvider (the thin-client Explorer, single-host today) is
**generalized to a per-machine authority** — `amico-host://<machine_id>/…` — routing by
that authority to each peer's file client. The focused machine's workspace is browsable in
the Explorer. For humans it is **read/review only**; its write routes stay unbuilt (issue
#1267) — see §D7.

This is **not** a small reuse of the existing routes: the current host client is built on
the **vault-browser** contract (`/amicode/vaults`, `/amicode/vault-files`,
`/amicode/vault-file`), which models *mounts* and reads **text only** (binary reports
`not_text`). Extending it to arbitrary *workspace roots* is new host routes + provider
re-keying + binary support. It therefore splits into (a) per-machine authority routing over
the existing read contract, and (b) the workspace-root and binary read extensions —
**binary is a follow-up**, not v1.

### §D6 — Session provenance lives in the session header, not the titlebar

The **session header** — the sticky session-title bar at the top of the Chat timeline
(which already hosts the title, the context-usage ring, and Compact) — is the home for
session provenance:

- a **computer icon** to the left of the title on **remote** sessions (hover → machine
  name); absent on local sessions (absence = local);
- a **provenance caret** next to the title opening a menu: **Machine · Workspace · Branch**
  (+ Open folder / Copy path). A remote session's branch/worktree is a git-status read
  routed to the owner via the multiplexer.

The **titlebar is left as implemented** (tabs, `+`, and the portalled Sessions/Status/
Side-Panel controls stay). There is **no per-tab machine glyph** — machine denotation lives
in the session header (active session) and the fleet-wide list badges (all sessions).
For a **new** session, the machine picker is the **first** control in the composer's
selector cascade — Machine ▸ Project ▸ Worktree/branch — defaulting to the focused machine,
overridable to any machine.

### §D7 — Remote workspace file mutation

| How | Edit existing file content | Create / delete / rename files & folders |
|---|---|---|
| **Agent** (in a session) | ✓ in-place on owner | ✓ in-place on owner |
| **Preview tab** (engine `file.write`, multiplexed to owner) | ✓ in-window, as if local | ✗ (content editor, not a file manager) |
| **Native Explorer** (`amico-host://`) | ✗ read/review only (#1267) | ✗ read/review only |
| **Remote-SSH** window | ✓ native | ✓ native |

In-window human editing of remote file **content** is available through the **Preview
tab**, which writes via the opencode engine `file` API — the *same engine plane the agent
uses*, so it is governed by the same peer-trust credential and accept-set (ADR 0032) and
needs no `#1267` host-FS write route. **Two honest caveats** the design must carry:

- It is **not free routing**: the engine `file` API is path-less, so it depends entirely on
  the owner-routing key of §D1a. "Same plane the agent uses" governs *authorization*, not
  *routing*.
- That plane permits **arbitrary absolute-path writes** on the owner (the engine handler
  mkdir-creates files outside the workspace). So the "content editor, not a file manager"
  containment is a **UI convention, not a plane property**, and a peer token therefore
  confers **arbitrary-path write** on the owner (shell-equivalent) unless constrained.
  Decision: the multiplexed **human** write path (Preview) is **gated server-side to
  workspace-relative paths** (reject `isAbsolute`); the broader "no new blast radius" claim
  is corrected to: *a peer token's write reach equals the agent's today, which is
  arbitrary-path — so the human Preview surface is deliberately narrowed below it.*

Human **structural** operations (new/delete/rename, folders) go to the agent (in-place) or
Remote-SSH. Building a host-FS write plane over `amico-host://` (call it Option B) is **out
of scope** — the Preview tab covers in-window content editing without it.

### §D8 — Thin-client and Remote-SSH reframed as transport, not a choice

The ADR 0030 "which connection mode?" Quick Pick is **removed**. In its place:

- **Thin-client** stops being a user decision — it is the **background transport** the
  multiplexer and the workspace browser use to reach peers; its sub-kind (SSH / tailscale /
  direct) is per-machine config resolved by `fleet_transport.ts`, never a per-click prompt.
- **Remote-SSH** is a **secondary, explicit per-device escape hatch** (a hover/overflow
  action on the FLEET device row, mirrored in the provenance menu's *Machine* entry) for
  native full-editor / structural / heavy work, and the **degraded fallback** when the
  multiplexer cannot reach a focused machine in place. It opens a **separate VS Code
  window** on the host (it inherently cannot be "backgrounded" — a window has one remote
  authority), in which the extension runs on the host (a full second studio there).

This **supersedes ADR 0030 §D2** and **reframes ADR 0025** (Remote-SSH is the escape
hatch/lifeboat, not the default posture).

**Disposition of ADR 0030 §D3–§D5** (so they are not silently orphaned): §D2's removal
retires the "attach to view sessions" purpose, which §D1/§D2 now subsume. The single
attachment pointer is retired **for session routing** (§D1a); its **boot-time recovery**
(0030 §D3, already partly built) and **credential provisioning** (0030 §D5) are
**subsumed by** the per-peer trust exchange (ADR 0032) and the per-session routing key
(§D1a) — the recovered pointer no longer routes sessions. Fleet Studio keeps **global**
`/amicode/*` reads (profile, problems, catalog) **local** (§D3, home base local), so no
residual single-target pointer is needed for them either. Net: the 0030 pointer machinery
is retired, not repurposed; the Remote-SSH resolver (0030 §D8) survives as §D8's escape
hatch.

### Staging (delivery order — foundation first, vertical thereafter)

1. Peer-trust credential + accept-set (ADR 0032) — the readiness-gated `auth=open` close is
   an explicit acceptance criterion.
2. Fan-outs + fleet-wide session list + machine badges.
3. Session multiplexer + SSE relay (routes session traffic **and** the engine file API).
4. Focused-machine sidebar + fleet-wide `amico-host://<machine>` read/review browser.
5. Session-header provenance + new-session machine picker + Preview-tab remote editing +
   Remote-SSH escape hatch.

## Approaches considered

- **Keep per-device window swap (ADR 0030 as-is)** — rejected: it is the exact pain the
  researcher named; one machine's sessions visible at a time, a reload to switch.
- **Native multi-origin switcher (the app talks to N servers directly)** — rejected for the
  data plane (as ADR 0027 already rejected): it bypasses `/amicode/*` ownership, credential
  translation, and the single-origin CSP/auth the accept-set depends on.
- **Single-target, seamless-switch (live re-target, one machine live at a time, #1353)** —
  rejected as the target: it cannot stream a solve on one machine while you work on
  another, which is the defining Amicode use. Kept only as the interim open behavior until
  the multiplexer lands.
- **Full host-FS read/write plane over `amico-host://` (Option B)** — rejected for now: the
  Preview tab already gives in-window content editing on a governed plane; Option B is a
  broader, security-sensitive write surface whose only added value is native-Explorer human
  structural edits, which Remote-SSH and the agent already cover.
- **Per-tab machine glyph** — rejected: it would modify the titlebar tab strip, which the
  researcher chose to leave untouched; the session header + list badges denote machine.

## Invariants held

- **Single app origin (ADR 0027).** The app never opens N origins; the local service
  multiplexes.
- **One-parser `fleet.json` (ADR 0023).** Everything new is amicode-owned (routing map,
  fan-outs, focus state).
- **Read-only roster (ADR 0026).** The focus selector writes no roster row.
- **Local honesty surface (ADR 0027 §4).** `/amicode/fleet/*` and the posture surfaces stay
  local and never proxy.
- **No silent local fallback.** A remote read/write that cannot reach its owner surfaces the
  honest degraded outcome (HubDown / Unavailable), never a fabricated success or a local
  read (the `host_file_client` guarantee).

## Consequences

- The fleet becomes one studio: every session and workspace is visible and (per §D7)
  workable in one window.
- Sessions gain durable, visible machine identity (badge + provenance header) — the
  researcher's original ask.
- The single attachment pointer is retired for session routing; routing is per-session.
- Remote-SSH's role narrows to an explicit escape hatch + fallback; thin-client becomes
  invisible transport.
- New substrate seams are made live that ADR 0027 reserved: the multiplexing service, the
  per-attachment transport (now per-peer, read + interactive), and the event-relay seam.

## Non-goals

- The Horizon-2 compute-federation executor (server-to-server dispatch RPC, placement
  scheduler, artifact sync-back) — still ADR 0027's non-goal.
- A host-FS write plane over `amico-host://` (Option B, §D7).
- Multi-target *attachment* of the whole panel (routing is per-session; the panel is not
  "attached" to two machines).
- Moving a running session between machines (a migration, not in scope).

## Source

Design-of-record: the Fleet Studio PRD (drafted from the `brainstorming` → `grill-with-docs`
session of 2026-09-22). Paired trust ADR: 0032.
