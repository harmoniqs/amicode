// sidebar_fleet_section.ts — the slimmed, READ-ONLY sidebar fleet section
// (#1321, ADR 0026). TWO pure units, both browser-safe:
//
//   - buildFleetSectionModel(): roster rows + this machine's posture → the
//     view-model the webview renders. This is where the AC display rules live:
//     server_mode is surfaced as "role", last_report as "last-seen", the
//     per-device tri-state `health` is carried verbatim, capability tags are
//     split known/descriptive, the posture badge is derived, and an empty or
//     UNREACHABLE roster resolves to an honest state (never a fabricated list).
//   - renderFleetSection(): the view-model → DOM (per-device rows, the posture
//     badge, and the single Manage affordance). READ-ONLY: the only message it
//     can emit is the Manage navigation — there is no roster-write path.
//
// NODE-IMPORT-FREE by construction: this module is bundled into the browser
// webview (platform: browser), exactly like sidebar_bridge.ts. It therefore
// re-declares the tiny slice of the @amicode/schema roster vocabulary it needs
// as literal unions rather than importing across the node seam — the same
// seam-crossing precedent fleet_posture_feed.ts sets for the posture vocabulary.

/** The per-device reachability tri-state (schema HEALTH_VOCABULARY, #1318). */
export type RosterHealth = "reachable" | "degraded" | "down";

/** Age (ms) at which a "reachable" row degrades to "degraded" (~2 missed heartbeats). */
export const DEGRADED_AGE_MS = 60_000;

/** Age (ms) at which a "reachable" row degrades to "down" (~4 missed heartbeats). */
export const DOWN_AGE_MS = 120_000;

/** Derive display health from roster health + last_report age. Pure.
 *  Enrollment-time failures (degraded/down) pass through unchanged.
 *  Only "reachable" rows are subject to staleness decay. */
export function effectiveHealth(health: RosterHealth, lastSeen: string, now: number): RosterHealth {
  if (health !== "reachable") return health;
  const ts = Date.parse(lastSeen);
  if (!Number.isFinite(ts) || ts > now) return health;
  const age = now - ts;
  if (age >= DOWN_AGE_MS) return "down";
  if (age >= DEGRADED_AGE_MS) return "degraded";
  return "reachable";
}

/** Format millisecond age into a human-readable relative timestamp.
 *  Reports the single most-significant unit as a fraction:
 *    <5s → "just now", <60s → "42s ago", <60m → "12m ago",
 *    <24h → "3.5h ago", ≥24h → "2.1d ago". */
export function formatAge(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "just now";
  const totalSec = ms / 1000;
  if (totalSec < 5) return "just now";
  if (totalSec < 60) return `${Math.floor(totalSec)}s ago`;
  const totalMin = totalSec / 60;
  if (totalMin < 60) return `${Math.floor(totalMin)}m ago`;
  const totalHr = totalMin / 60;
  if (totalHr < 24) return `${round1(totalHr)}h ago`;
  return `${round1(totalHr / 24)}d ago`;
}

/** Round to one decimal place, dropping ".0". */
function round1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r % 1 === 0 ? String(r) : r.toFixed(1);
}

/** The KNOWN behavior-adjacent capability tags (schema KNOWN_CAPABILITY_TAGS,
 *  ADR 0026 §1) — re-declared here to keep this module node-import-free. Any
 *  OTHER tag is a valid descriptive label (known:false), never rejected. */
const KNOWN_CAPABILITY_TAGS = ["compute", "roaming"] as const;
function isKnownCapability(tag: string): boolean {
  return (KNOWN_CAPABILITY_TAGS as readonly string[]).includes(tag);
}

/** The structural roster-row shape this module consumes (the @amicode/schema
 *  RosterRow — accepted structurally so the host can pass real parsed rows and
 *  tests can pass literals, without a node import). */
export interface RosterRowLike {
  machine_id: string;
  name: string;
  server_mode: string;
  capabilities: string[];
  last_report: string;
  health: RosterHealth;
  /** Optional device form factor self-report (schema RosterRow.device_type,
   *  #1359) — the type-pill's primary source. Absent ⇒ the pill falls back
   *  to `server_mode` (the hybrid fallback). */
  device_type?: string;
}

/** A capability tag split into known-behavior vs descriptive (ADR 0026 §1). */
export interface FleetCapabilityChip {
  tag: string;
  /** True for the behavior-adjacent tags (compute, roaming); false = a valid
   *  descriptive label carrying no built-in meaning. */
  known: boolean;
}

/** One rendered device row — the roster row after display-labelling. */
export interface FleetDeviceRow {
  machineId: string;
  name: string;
  /** server_mode, surfaced under the "role" label. */
  role: string;
  /** The type-pill's resolved label: device_type when the row reports one,
   *  else server_mode (the hybrid fallback, #1359). */
  typeLabel: string;
  capabilities: FleetCapabilityChip[];
  health: RosterHealth;
  /** last_report, surfaced under the "last-seen" label. */
  lastSeen: string;
  /** True when this row represents the local machine (the self-row). */
  isLocal: boolean;
  /** The raw roster health before staleness folding (#1375). Only set on
   *  roster-sourced rows; undefined on synthesized rows (self, canonical). */
  rosterHealth?: RosterHealth;
}

/** The state of the section as a whole. `unreachable` is the honest host-down
 *  state (the roster could not be read) — DISTINCT from `empty` (read fine,
 *  zero devices). `standalone` is DISTINCT again: this machine carries no
 *  fleet.json at all, so there is no fleet to list devices FOR (#1359) — it
 *  takes priority over the roster's own reachability, which is irrelevant
 *  when you were never part of a fleet to begin with. Neither `unreachable`
 *  nor `standalone` ever fabricates a peer device list. */
export type FleetSectionState = "populated" | "empty" | "unreachable" | "standalone";

/** The attach-posture vocabulary (fleet_posture_state.ts FleetPostureMode). */
export type PostureMode = "fleet" | "standalone" | "degraded";

/** THIS machine's posture, as the posture feed reports it — the host passes
 *  this; `serverMode` is the serve-stance (fleet.json role), the rest is the
 *  attach posture the feed derives. */
export interface FleetPostureInput {
  serverMode: string;
  hostname: string;
  mode: PostureMode;
  reachable: boolean;
  hub: { name: string | null; base_url: string | null };
}

/** The rendered posture badge: this machine's Server mode + a folded
 *  link-health signal (ADR 0026's link-health axis, distinct from a peer's
 *  per-device `health`). */
export interface FleetPostureBadge {
  serverMode: string;
  hostname: string;
  linkHealth: "ok" | "degraded" | "down";
  hub: { name: string | null; base_url: string | null };
}

/** What buildFleetSectionModel needs. `rosterReachable` is the honesty signal:
 *  false ⇒ the roster read failed / host down ⇒ the `unreachable` state. */
export interface FleetSectionInput {
  roster: RosterRowLike[];
  rosterReachable: boolean;
  posture: FleetPostureInput | null;
  manageAvailable: boolean;
  /** Whether the Troubleshoot action is available — the host gates this on
   *  session-launch capability. Disabled ⇒ the button is absent (same honest
   *  degrade as Manage). */
  troubleshootAvailable: boolean;
  /** THIS machine's own identity, known independent of the roster (fleet.json
   *  serve-stance + hostname/config, #1359) — never fabricated: null/omitted
   *  when local identity can't be resolved. Drives the self-row synthesis and
   *  the "not registered with a fleet" collapse below. */
  localDevice?: LocalDeviceInput | null;
  /** The canonical server this machine points at (fleet.json `canonical`),
   *  known independent of the peer roster (#1363). On a CLIENT the server is
   *  never a roster row — the roster lists reporters (peers/clients) — so
   *  without this the client would never see the machine it's attached to.
   *  Synthesized into a server device row below when present, not the local
   *  machine, and not already carried by the roster. Null/omitted on a server
   *  or standalone machine (the server is its own self-row; a standalone has
   *  no canonical). */
  canonicalServer?: CanonicalServerInput | null;
  /** Injectable clock for staleness computation (#1375). Defaults to Date.now(). */
  now?: number;
}

/** The canonical-server seed — the machine a client points at, from fleet.json
 *  `canonical` (#1363). Deliberately minimal: identity only. `machineId`
 *  should be the canonical host (or sshAlias) so it de-dupes against a roster
 *  row for the same server if one ever appears. */
export interface CanonicalServerInput {
  machineId: string;
  name: string;
}

/** The self-row seed — independent of the roster, so a machine always sees
 *  itself even before any self-report producer exists (#1359). */
export interface LocalDeviceInput {
  machineId: string;
  name: string;
  /** The serve-stance (fleet.json role): server | client | standalone. */
  serveStance: string;
  /** Optional detected form factor — the type-pill's primary source. */
  deviceType?: string;
}

/** The complete view-model handed to the webview. */
export interface FleetSectionModel {
  state: FleetSectionState;
  devices: FleetDeviceRow[];
  posture: FleetPostureBadge | null;
  /** The single Manage affordance — enabled only when the Fleet Manager tab
   *  (#1322) is present. Disabled ⇒ honest degrade, no dead click. */
  manage: { enabled: boolean };
  /** The Troubleshoot affordance — enabled when session-launch is available
   *  AND this machine is part of a fleet (non-standalone). */
  troubleshoot: { enabled: boolean };
  /** Injectable clock timestamp for tooltip rendering (#1375). */
  now?: number;
}

/** Fold the attach posture into the badge's link-health signal: an attached,
 *  reachable hub is "ok"; the hub-up-but-slow steady state is "degraded";
 *  standalone or unreachable is "down" (never falsely healthy). */
function linkHealthOf(posture: FleetPostureInput): "ok" | "degraded" | "down" {
  if (posture.mode === "degraded") return "degraded";
  if (posture.mode === "fleet" && posture.reachable) return "ok";
  return "down";
}

/** Build the fleet-section view-model. Pure. */
export function buildFleetSectionModel(input: FleetSectionInput): FleetSectionModel {
  const local = input.localDevice ?? null;
  const now = input.now ?? Date.now();
  // No fleet.json at all (serve-stance standalone) ⇒ this machine was never
  // part of a fleet — the peer roster's reachability is irrelevant to that
  // fact, so this collapse takes PRIORITY over the unreachable check below
  // (#1359: "Current device not registered with a fleet", never a fleet-list
  // UI for a fleet that doesn't exist).
  if (local && local.serveStance === "standalone") {
    return {
      state: "standalone",
      devices: [],
      posture: buildPostureBadge(input.posture),
      manage: { enabled: input.manageAvailable },
      troubleshoot: { enabled: false },
      now,
    };
  }
  // Host down / roster read failed ⇒ the honest unreachable state. A stale
  // PEER roster array is deliberately DROPPED here — the section never
  // renders a possibly-stale list as if it were live (AC6, no fabricated
  // list). The self-row is a DIFFERENT kind of fact — independently known
  // from local fleet.json/config, not a read of the down peer roster — so it
  // still renders when known (#1359: "still show the self-row").
  if (!input.rosterReachable) {
    const localIsHub = local != null && local.serveStance === "server" && input.canonicalServer == null;
    const downDevices: FleetDeviceRow[] = local ? [localDeviceRow(local, localIsHub)] : [];
    // The canonical server is a fact known from fleet.json, not a read of the
    // down peer roster — so it still renders (as `down`, never fabricated as
    // healthy), the same way the self-row does (#1363).
    maybeAddCanonicalServer(downDevices, input.canonicalServer ?? null, local, "down");
    return {
      state: "unreachable",
      devices: downDevices,
      posture: buildPostureBadge(input.posture),
      manage: { enabled: input.manageAvailable },
      troubleshoot: { enabled: input.troubleshootAvailable },
      now,
    };
  }
  const localId = local?.machineId ?? null;
  const canonicalId = input.canonicalServer?.machineId ?? null;
  const devices: FleetDeviceRow[] = input.roster.map((r) => {
    const isHub = canonicalId !== null && r.machine_id === canonicalId;
    return {
      machineId: r.machine_id,
      name: r.name,
      role: displayRole(r.server_mode, isHub),
      typeLabel: r.device_type ?? displayRole(r.server_mode, isHub),
      capabilities: r.capabilities.map((tag) => ({ tag, known: isKnownCapability(tag) })),
      health: effectiveHealth(r.health as RosterHealth, r.last_report, now),
      rosterHealth: r.health as RosterHealth,
      lastSeen: r.last_report,
      isLocal: localId !== null && r.machine_id === localId,
    };
  });
  // Synthesize the self-row when the roster doesn't already carry one for
  // this machine, so you always see yourself — even before any self-report
  // producer exists, and even with an empty roster (#1359).
  if (local && !devices.some((d) => d.machineId === local.machineId)) {
    const localIsHub = local.serveStance === "server" && canonicalId == null;
    devices.unshift(localDeviceRow(local, localIsHub));
  }
  // Synthesize the canonical-server row on a client (the server is never a
  // roster row — the roster lists reporters), so you always see the machine
  // you're attached to. A reachable peer roster means the host answered, so
  // the server is `reachable` (#1363).
  maybeAddCanonicalServer(devices, input.canonicalServer ?? null, local, "reachable");
  // The local machine always renders first — whether it was synthesized
  // (already unshifted above) or found in the roster at an arbitrary index.
  const localIdx = devices.findIndex((d) => d.isLocal);
  if (localIdx > 0) {
    const [self] = devices.splice(localIdx, 1);
    devices.unshift(self);
  }
  const state: FleetSectionState = devices.length > 0 ? "populated" : "empty";
  // For a server-mode machine in a peer fleet, the data-plane posture detector
  // has nothing to observe (no hub proxy traffic), so linkHealth stays "down".
  // Override: derive link health from the roster — if any non-local peer is
  // reachable, the fleet is healthy. (#1394 follow-up, ADR 0029 peer posture.)
  let postureBadge = buildPostureBadge(input.posture);
  if (postureBadge && local && local.serveStance === "server") {
    const hasPeerUp = devices.some((d) => !d.isLocal && d.health === "reachable");
    const allPeersDown = devices.filter((d) => !d.isLocal).length > 0 &&
      devices.filter((d) => !d.isLocal).every((d) => d.health === "down");
    postureBadge = {
      ...postureBadge,
      linkHealth: hasPeerUp ? "ok" : allPeersDown ? "down" : "degraded",
    };
  }
  return {
    state,
    devices,
    posture: postureBadge,
    manage: { enabled: input.manageAvailable },
    troubleshoot: { enabled: input.troubleshootAvailable },
    now,
  };
}

/** Derive the posture badge, or null when posture is unknown (never fabricated). */
function buildPostureBadge(posture: FleetPostureInput | null): FleetPostureBadge | null {
  if (!posture) return null;
  return {
    serverMode: posture.serverMode,
    hostname: posture.hostname,
    linkHealth: linkHealthOf(posture),
    hub: { name: posture.hub.name ?? null, base_url: posture.hub.base_url ?? null },
  };
}

/** Build the synthesized self-row from local identity (#1359). Health is
 *  always `reachable` — you can always see yourself, regardless of the peer
 *  roster's reachability. `lastSeen` is the literal "now" (not a real ISO
 *  stamp): this row is never a self-report read off disk, so there is no
 *  provenance timestamp to show, and a pure function must not call the
 *  clock to invent one. */
function localDeviceRow(local: LocalDeviceInput, isCanonicalHub = false): FleetDeviceRow {
  const role = displayRole(local.serveStance, isCanonicalHub);
  return {
    machineId: local.machineId,
    name: local.name,
    role,
    typeLabel: local.deviceType ?? role,
    capabilities: [],
    health: "reachable",
    lastSeen: "now",
    isLocal: true,
  };
}

/** Add the synthesized canonical-server row to `devices` in place, unless it
 *  would double a row that already exists — the local machine's own self-row
 *  (the server viewing itself) or a roster row for the same server (#1363).
 *  `health` is the caller's honest signal: `reachable` when the host answered
 *  the roster read, `down` when it didn't. */
function maybeAddCanonicalServer(
  devices: FleetDeviceRow[],
  server: CanonicalServerInput | null,
  local: LocalDeviceInput | null,
  health: RosterHealth,
): void {
  if (!server) return;
  // The server IS this machine ⇒ it's the self-row, never a synthesized peer.
  if (local && local.machineId === server.machineId) return;
  // Already carried (a roster row for the same server) ⇒ don't duplicate.
  if (devices.some((d) => d.machineId === server.machineId)) return;
  devices.push(canonicalServerRow(server, health));
}

/** Build the synthesized canonical-server row (#1363). Like the self-row, this
 *  is a fact known from fleet.json, not a self-report read off disk — so
 *  `lastSeen` is the literal "now" and there is no capability list. */
function canonicalServerRow(server: CanonicalServerInput, health: RosterHealth): FleetDeviceRow {
  return {
    machineId: server.machineId,
    name: server.name,
    role: "server",
    typeLabel: "server",
    capabilities: [],
    health,
    lastSeen: "now",
    isLocal: false,
  };
}

// ── DOM render (browser / webview) ───────────────────────────────────────────

/** The single navigation message the section can emit — the READ-ONLY contract:
 *  there is no roster-write / management message (AC4). */
export interface OpenFleetManagerRequest {
  kind: "open-fleet-manager";
}

/** Request to spawn a troubleshoot-fleet session — the Troubleshoot button's
 *  click payload. The host handler opens a new chat session that invokes the
 *  troubleshoot-fleet skill. */
export interface TroubleshootFleetRequest {
  kind: "troubleshoot-fleet";
}

/** The union of navigation messages the fleet section can emit. Navigation
 *  actions only — no roster-write path (ADR 0026, updated for #1413). */
export type FleetSectionMessage = OpenFleetManagerRequest | TroubleshootFleetRequest | ConnectToDeviceRequest;

/** #1413 — connect to a fleet device. Posted on device row click. The message
 *  carries identity only; all precondition data is resolved host-side. */
export interface ConnectToDeviceRequest {
  kind: "connect-to-device";
  machineId: string;
  deviceName: string;
  isLocal: boolean;
}

/** Human-readable label for a per-device health tri-state (color is never the
 *  only signal — the label always accompanies the indicator). */
function healthLabel(health: RosterHealth): string {
  return health; // reachable | degraded | down — the vocabulary is already legible
}

/** Focused tooltip for the status indicator dot: human-readable health +
 *  relative last-seen age, so you can hover just the dot and learn when the
 *  machine last reported without reading the full row tooltip. */
function dotStatusTooltip(device: FleetDeviceRow, now?: number): string {
  const status = device.health === "reachable" ? "Connected"
    : device.health === "degraded" ? "Connection degraded"
    : "Disconnected";
  if (now !== undefined) {
    const ts = Date.parse(device.lastSeen);
    if (Number.isFinite(ts)) return `${status} · last seen ${formatAge(now - ts)}`;
  }
  return status;
}

// ── DOM render helpers ───────────────────────────────────────────────────────

/** Render one device row: a file-list-style line — status dot, name, type pill
 *  (#1359). Clickable: posts a `connect-to-device` message (#1413, ADR 0030 §D1).
 *  `role` / `last-seen` / `capabilities` move to the row's `title` tooltip. */
function renderDeviceRow(
  device: FleetDeviceRow,
  now: number | undefined,
  post: (msg: FleetSectionMessage) => void,
): HTMLElement {
  const rowEl = document.createElement("div");
  rowEl.className = "fleet-device-row";
  rowEl.setAttribute("data-machine-id", device.machineId);
  rowEl.title = deviceTooltip(device, device.rosterHealth, now);

  // #1413: click → connect-to-device message
  rowEl.addEventListener("click", () => {
    post({
      kind: "connect-to-device",
      machineId: device.machineId,
      deviceName: device.name,
      isLocal: device.isLocal,
    });
  });

  // left: a status dot — color is never the only signal, so the same
  // tri-state also carries as an aria-label (a11y) even without inline text.
  const dot = document.createElement("span");
  dot.className = "fleet-status-dot";
  dot.setAttribute("data-health", device.health);
  dot.setAttribute("aria-label", healthLabel(device.health));
  dot.setAttribute("data-tooltip", dotStatusTooltip(device, now));
  rowEl.appendChild(dot);

  // middle: the device name + optional "(This Machine)" badge.
  const name = document.createElement("span");
  name.className = "fleet-device-name";
  name.textContent = device.name;
  rowEl.appendChild(name);

  if (device.isLocal) {
    const badge = document.createElement("span");
    badge.className = "fleet-local-badge";
    badge.textContent = "(This Machine)";
    rowEl.appendChild(badge);
  }

  // right: the type pill — device_type when the row reports one, else server_mode.
  const pill = document.createElement("span");
  pill.className = "fleet-type-pill";
  pill.textContent = device.typeLabel;
  rowEl.appendChild(pill);

  return rowEl;
}

/** Map the raw `server_mode` to a user-friendly display role.
 *  The canonical hub stays "server"; a non-hub server is a "peer" (ADR 0029);
 *  everything else passes through unchanged. `isCanonicalHub` is true when the
 *  row represents this fleet's canonical server (the machine fleet.json points
 *  at — the hub whose health endpoint clients/peers check). */
export function displayRole(serverMode: string, isCanonicalHub: boolean): string {
  if (serverMode === "server" && !isCanonicalHub) return "peer";
  return serverMode;
}

/** The row's hover tooltip: role, last-seen, and capabilities — demoted from
 *  inline text (#1359) but not lost. When `now` is available, last-seen shows
 *  relative age via formatAge (#1375). When staleness changed the display
 *  health (rosterHealth ≠ device.health), the change is annotated. */
function deviceTooltip(device: FleetDeviceRow, rosterHealth?: RosterHealth, now?: number): string {
  let lastSeenText: string;
  if (now !== undefined) {
    const ts = Date.parse(device.lastSeen);
    lastSeenText = Number.isFinite(ts) ? formatAge(now - ts) : device.lastSeen;
  } else {
    lastSeenText = device.lastSeen;
  }
  const parts = [`role: ${device.role}`, `last-seen: ${lastSeenText}`];
  if (rosterHealth !== undefined && device.health !== rosterHealth) {
    parts.push(`${device.health} (no heartbeat)`);
  }
  if (device.capabilities.length > 0) {
    parts.push(`capabilities: ${device.capabilities.map((c) => c.tag).join(", ")}`);
  }
  return parts.join(" · ");
}

/** The single Manage affordance — a button that posts the navigation message.
 *  Only ever constructed when enabled (#1359): when the Fleet Manager tab
 *  (#1322) is absent, `renderFleetSection` skips this entirely — no dead
 *  disabled control sitting in the DOM (AC3, sharpened from "disabled" to
 *  "absent"). */
function renderManage(post: (msg: FleetSectionMessage) => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fleet-manage";
  btn.textContent = "Manage";
  btn.setAttribute("aria-label", "Manage fleet");
  btn.addEventListener("click", () => post({ kind: "open-fleet-manager" }));
  return btn;
}

/** The Troubleshoot affordance — a button that spawns a new session invoking
 *  the troubleshoot-fleet skill. Same honest-degrade pattern as Manage:
 *  absent when disabled, never a dead click. */
function renderTroubleshoot(post: (msg: FleetSectionMessage) => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fleet-troubleshoot";
  btn.textContent = "Troubleshoot";
  btn.setAttribute("aria-label", "Troubleshoot fleet");
  btn.addEventListener("click", () => post({ kind: "troubleshoot-fleet" }));
  return btn;
}

/** The action bar: Manage + Troubleshoot, rendered at the TOP of the fleet
 *  section (before the device list). Returns null when neither button is
 *  enabled — the caller omits the bar entirely. */
function renderActionBar(model: FleetSectionModel, post: (msg: FleetSectionMessage) => void): HTMLElement | null {
  if (!model.manage.enabled && !model.troubleshoot.enabled) return null;
  const bar = document.createElement("div");
  bar.className = "fleet-action-bar";
  if (model.manage.enabled) bar.appendChild(renderManage(post));
  if (model.troubleshoot.enabled) bar.appendChild(renderTroubleshoot(post));
  return bar;
}

/**
 * Render the fleet section into `container` from the view-model. Pure DOM +
 * a `post` callback (the webview passes vscode.postMessage). READ-ONLY: the
 * only message it can emit is the Manage navigation (AC4).
 */
export function renderFleetSection(
  container: HTMLElement,
  model: FleetSectionModel,
  post: (msg: FleetSectionMessage) => void,
): void {
  container.innerHTML = "";

  // #1359: the posture badge ("Server / down") is RETIRED — the self-row in
  // the device list now carries the same information (status dot + type pill)
  // without the misleading "down" alarm that triggered this whole redesign.
  // The model still computes `posture` for consumers that might want it
  // (e.g. the Fleet Manager tab), but the sidebar no longer renders it.

  if (model.state === "standalone") {
    // No fleet.json at all — there is no fleet to list devices for (#1359).
    // Never a device row here; the model guarantees devices is empty too.
    // No action bar either — there's no fleet to manage or troubleshoot.
    const notice = document.createElement("div");
    notice.className = "fleet-standalone fleet-placeholder-text";
    notice.textContent = "Current device not registered with a fleet.";
    container.appendChild(notice);
  } else {
    // Action bar (Manage + Troubleshoot) renders at the TOP, before the
    // device list — absent entirely when neither button is enabled.
    const bar = renderActionBar(model, post);
    if (bar) container.appendChild(bar);

    if (model.state === "unreachable") {
      const down = document.createElement("div");
      down.className = "fleet-unreachable fleet-placeholder-text";
      down.textContent = "Fleet host unreachable";
      container.appendChild(down);
    } else if (model.state === "empty") {
      const empty = document.createElement("div");
      empty.className = "fleet-empty fleet-placeholder-text";
      empty.textContent = "No devices reporting yet";
      container.appendChild(empty);
    }
    if (model.devices.length > 0) {
      const list = document.createElement("div");
      list.className = "fleet-device-list";
      for (const device of model.devices) {
        list.appendChild(renderDeviceRow(device, model.now, post));
      }
      container.appendChild(list);
    }
  }
}
