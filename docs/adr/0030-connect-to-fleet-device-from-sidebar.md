# ADR 0030 — Connect to fleet device from the sidebar

- **Status:** proposed (reviewed: round 2, `approved-mechanical` — three manual critics, no tooling)
- **Date:** 2026-09-21
- **Context refs:** ADR 0026 (host-owned roster — device rows, sshAlias, transport),
  ADR 0027 §D3 (attach/switch as a first-class action, the switch-control pointer),
  ADR 0025 (Remote-SSH default — the hub-only `connectRemoteSsh` command),
  ADR 0029 (unified fleet serving — `serving` capability replaces topology roles)
- **Review:** round 1 returned 1 contradiction + 15 advisories (manual, three critics,
  one lens each). This revision addresses the contradiction (boot-time pointer recovery)
  and folds in the advisories that change the design surface.

## Context

The fleet sidebar (ADR 0026, #1321) renders device rows from the roster but they are
read-only — clicking a device does nothing. The existing remote-connection paths are
indirect: Remote-SSH (`amicode.fleet.connectRemoteSsh`) connects only to the hub,
and the attach API (`POST /amicode/fleet/attach`) is reachable only through code or
the CLI, not the sidebar.

Users see their devices listed but have no gesture to *work on* one. A researcher
with a Mac Studio (server) and a MacBook (client) should be able to click the Studio
in the sidebar and start viewing its sessions, without leaving the Amicode window or
remembering the CLI.

**Boot-time recovery gap.** ADR 0029 §9 explicitly states that boot-time recovery of
the attachment proxy from the on-disk pointer is "named, not built." After `POST
/amicode/fleet/attach` writes the pointer and the window reloads, the D3 resolver in
`server.ts` never enters the `attached` branch because no `HubProxy` is live — the
user would see their own local sessions, not the target device's. This gap makes the
Thin Client path inoperative without new boot-time wiring.

**Synthesized canonical-server row.** On a CLIENT machine, the hub row in the sidebar
is synthesized from `fleet.json`'s `canonical` field, not from the roster. The attach
API (`attachActionResponse`) refuses `unknown_machine` when no roster row matches.
The primary use case — a client clicking the hub — fails the roster gate.

## Decision

### §D1 — Device rows become clickable

A left-click on any device row in the fleet sidebar posts a `connect-to-device`
message through the existing typed bridge. This is a navigation action (like the
existing Manage and Troubleshoot buttons), not a roster write — ADR 0026's read-only
contract for the *roster* is preserved. The sidebar's header comments are updated to
reflect the accurate contract: "navigation actions only, no roster-write path."

A one-shot click guard prevents rapid double-clicks from stacking Quick Picks,
matching the existing file-tree debounce pattern in `sidebar_webview.ts`.

### §D2 — Quick Pick with two connection modes for remote devices

On click, the host shows a VS Code Quick Pick titled "View sessions on [device name]
remotely?" with two items:

| Option | Label | Mechanism |
|---|---|---|
| **Thin Client** | "Thin Client (Poor Connection)" | `POST /amicode/fleet/attach` with the target's `machine_id` + credential provisioning → window reload. Reuses ADR 0027 §D3's attach/switch action and §D9's per-attachment transport. |
| **Remote SSH** | "Remote SSH (Strong Connection)" | Generalise ADR 0025's `resolveRemoteSshTarget` to accept any device's `sshAlias` → `vscode.openFolder` in a new Remote-SSH window. |

**Preconditions (disable with inline note when unmet):**

| Condition | Disables | Note shown |
|---|---|---|
| Target lacks `serving` capability (ADR 0029) | Thin Client | "Not running a server" |
| Target `health === "down"` | Thin Client | "Device unreachable" |
| Target has no `sshAlias` | Remote SSH | "No SSH alias configured" |
| `ms-vscode-remote.remote-ssh` extension absent | Remote SSH | "Requires Remote-SSH extension" |

A confirmation dialog precedes the window reload for Thin Client ("This will reload
the window and connect to [device]. Any in-progress chat will restart. Continue?"),
matching the existing `goStandalone` confirmation pattern.

### §D3 — Boot-time pointer recovery (the blocking prerequisite)

This feature **includes** wiring boot-time pointer recovery as part of its
implementation scope. Specifically:

1. On extension activation, read the attachment pointer from
   `~/.amico/ops/fleet/attachment.json` (via `resolveAttachmentPointer`).
2. When a valid, non-empty pointer is found and this machine is not a hub-connected
   `client` (i.e., it's a standalone or peer with an attachment), spin up the
   per-attachment transport (§D9 of ADR 0027) for the pointed-to device.
3. Register the resulting `HubProxy` on `fleetPlane.attached` so the D3 resolver
   enters the `attached` branch on the next request.

This is the minimum wiring that makes `attach → reload → proxied sessions` work
end-to-end. It does NOT build the live re-target (switching without reload) that
ADR 0029 §9 defers to #1353 — the reload is still required.

### §D4 — Two-branch device resolution (roster + topology)

The host-side handler for `connect-to-device` resolves device coordinates through
**two sources**, because the canonical-server row on a client is synthesized from
`fleet.json`, not from the roster:

1. **Roster lookup** — `roster.rows.find(r => r.machine_id === machineId)`. Carries
   `sshAlias`, `transport`, `capabilities`, `health`, `server_mode`.
2. **Topology fallback** — when the roster lookup misses, read `fleet.json`'s
   `canonical` for the `sshAlias` and derive `serving = true` (the canonical server
   is serving by definition). The `transport` field defaults to `"ssh"` (the
   canonical's `sshAlias` implies SSH transport — the universal floor per ADR 0027 §D9).

The attach API (`attachActionResponse`) is amended to accept the canonical server as
a valid target: when `machine_id` is not in the roster but matches the topology's
canonical, resolve coordinates from the canonical instead. This closes the
synthesized-row gap.

### §D5 — Credential provisioning on Thin Client attach

The sidebar's Thin Client path includes `base_url` and `token` in the attach request
body — not just `machine_id`. The handler resolves these from:

1. **Roster row** — `base_url` from the roster's transport-resolved URL.
2. **Existing credential** — if a per-attachment credential for the target already
   exists (from prior enrollment or Fleet Manager attach), reuse it.
3. **Topology canonical** — for the canonical server, `base_url` is derived from
   `canonical.host` + `canonical.port`.

When no credential can be resolved, the Thin Client option is disabled with the note
"No credentials available — use the Fleet Manager to connect."

### §D6 — Separate write seam (not FleetSectionDeps)

The existing `FleetSectionDeps` interface is read-only by documented contract. The
connect-to-device handler is wired through a **separate injectable** — either a new
`FleetConnectDeps` interface or a method on the `SidebarViewProvider` — injected from
`extension.ts` where the service URL, auth headers, and roster are all available.
This keeps the read-only fleet section contract intact.

### §D7 — Local device shows "Go Standalone" with hub-aware warning

Clicking the "(This Machine)" row offers the existing `amicode.fleet.goStandalone`
command. When this machine is the hub (topology role is server AND other devices exist
in the roster), the confirmation dialog is upgraded to warn: "This machine is the hub
— going standalone will disconnect [N] other device(s). Continue?"

### §D8 — Remote SSH resolver generalised, not forked

A new `resolveDeviceRemoteSshTarget(sshAlias, workspacePath?)` entry point accepts a
raw alias; the existing hub path (`connectToHubOverRemoteSsh`) calls it internally.
One resolver, two callers. Before showing the Remote SSH option, the handler probes
`vscode.extensions.getExtension("ms-vscode-remote.remote-ssh")` — absent means
disabled.

## Approaches considered

- **Context menu (right-click)** — rejected: webview context menus are unreliable
  across platforms; the webview `contextmenu` event is suppressed by VS Code on some
  platforms. A left-click Quick Pick is the standard VS Code pattern.
- **Inline button per row** — rejected: adds visual clutter to a section whose
  strength is its clean device list. A click on the row itself is discoverable via
  cursor change.
- **Full per-device proxy (thin client to any device simultaneously)** — rejected for
  now: ADR 0027's attach pointer is single-target by design. The re-attach path gets
  the job done without new proxy infrastructure.
- **Defer to #1353 for boot-time recovery** — rejected: shipping the sidebar gesture
  without a working Thin Client path would be a dead button. The minimum wiring
  (read pointer at boot, spin up transport, register proxy) is scoped here; the live
  re-target (switch without reload) stays with #1353.
- **`server_mode != "client"` as Thin Client gate** — rejected: ADR 0029 establishes
  `capabilities.includes("serving")` as the authoritative predicate for attachability.

## Invariants held

- **ADR 0026 §read-only roster** — the sidebar emits no roster-write message. The new
  message is a navigation action. The `FleetSectionDeps` read-only contract is
  preserved; the write path uses a separate seam (§D6).
- **ADR 0027 §D3 single-writer pointer** — the Thin Client path drives the existing
  attach API; no second pointer writer.
- **ADR 0027 §D3 roster-as-sole-candidate — amended.** §D4 adds the topology canonical
  as a second trusted coordinate source when the roster lookup misses. The security
  property ("the caller cannot forge a coordinate") is preserved: coordinates are
  resolved from `fleet.json` (a trusted local config file), never from the request body.
- **ADR 0025 §Remote-SSH authority** — Remote-SSH opens via the same
  `vscode-remote://ssh-remote+<alias>/` URI; the generalisation adds no new authority
  scheme.
- **ADR 0029 §serving capability** — the Thin Client gate uses
  `capabilities.includes("serving")`, not `server_mode`.

## Consequences

- Every device in the fleet sidebar becomes a first-class navigation target.
- The Thin Client path makes the attach/switch action (ADR 0027 §D3) user-accessible
  from the sidebar for the first time — previously it was CLI-only or Fleet Manager-only.
- **Boot-time pointer recovery is wired** (§D3), unblocking this feature and any
  future attach UX. The reload is still required; live re-target stays with #1353.
- The generalised Remote-SSH resolver is independently useful for any future "connect
  to device X" surface (Fleet Manager, command palette).
- The attach API is amended to accept the canonical server as a valid target (§D4),
  closing a gap that would also affect the Fleet Manager's attach gesture.

## Non-goals

- Multi-target attachment (connecting to two devices simultaneously as thin client).
- Per-device workspace path configuration (uses the same `hubWorkspacePath` setting).
- Live re-target (switching attached device without window reload) — stays with #1353.
- Full credential lifecycle in the sidebar (enrollment, rotation) — the Fleet Manager
  owns that; the sidebar reuses existing credentials or disables the option.

## Source

Implementing issue: #1409.
