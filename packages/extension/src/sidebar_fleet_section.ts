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
  capabilities: FleetCapabilityChip[];
  health: RosterHealth;
  /** last_report, surfaced under the "last-seen" label. */
  lastSeen: string;
}

/** The state of the section as a whole. `unreachable` is the honest host-down
 *  state (the roster could not be read) — DISTINCT from `empty` (read fine,
 *  zero devices). Neither ever fabricates a device list. */
export type FleetSectionState = "populated" | "empty" | "unreachable";

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
}

/** The complete view-model handed to the webview. */
export interface FleetSectionModel {
  state: FleetSectionState;
  devices: FleetDeviceRow[];
  posture: FleetPostureBadge | null;
  /** The single Manage affordance — enabled only when the Fleet Manager tab
   *  (#1322) is present. Disabled ⇒ honest degrade, no dead click. */
  manage: { enabled: boolean };
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
  // Host down / roster read failed ⇒ the honest unreachable state. A stale
  // roster array is deliberately DROPPED here — the section never renders a
  // possibly-stale list as if it were live (AC6, no fabricated list).
  if (!input.rosterReachable) {
    return {
      state: "unreachable",
      devices: [],
      posture: buildPostureBadge(input.posture),
      manage: { enabled: input.manageAvailable },
    };
  }
  const devices: FleetDeviceRow[] = input.roster.map((r) => ({
    machineId: r.machine_id,
    name: r.name,
    role: r.server_mode,
    capabilities: r.capabilities.map((tag) => ({ tag, known: isKnownCapability(tag) })),
    health: r.health,
    lastSeen: r.last_report,
  }));
  const state: FleetSectionState = devices.length > 0 ? "populated" : "empty";
  return {
    state,
    devices,
    posture: buildPostureBadge(input.posture),
    manage: { enabled: input.manageAvailable },
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

// ── DOM render (browser / webview) ───────────────────────────────────────────

/** The single navigation message the section can emit — the READ-ONLY contract:
 *  there is no roster-write / management message (AC4). */
export interface OpenFleetManagerRequest {
  kind: "open-fleet-manager";
}

/** Human-readable label for a per-device health tri-state (color is never the
 *  only signal — the label always accompanies the indicator). */
function healthLabel(health: RosterHealth): string {
  return health; // reachable | degraded | down — the vocabulary is already legible
}

/** Render THIS machine's posture badge into the section. */
function renderPostureBadge(badge: FleetPostureBadge): HTMLElement {
  const el = document.createElement("div");
  el.className = "fleet-posture-badge";
  el.setAttribute("data-link-health", badge.linkHealth);
  const mode = document.createElement("span");
  mode.className = "fleet-posture-mode";
  mode.textContent = badge.serverMode;
  const link = document.createElement("span");
  link.className = "fleet-posture-link";
  link.setAttribute("data-link-health", badge.linkHealth);
  link.textContent = badge.linkHealth;
  el.appendChild(mode);
  el.appendChild(link);
  return el;
}

/** Render one read-only device row. */
function renderDeviceRow(device: FleetDeviceRow): HTMLElement {
  const rowEl = document.createElement("div");
  rowEl.className = "fleet-device-row";
  rowEl.setAttribute("data-machine-id", device.machineId);

  const name = document.createElement("span");
  name.className = "fleet-device-name";
  name.textContent = device.name;
  rowEl.appendChild(name);

  // server_mode under the "role" label.
  const role = document.createElement("span");
  role.className = "fleet-device-role";
  role.textContent = `role: ${device.role}`;
  rowEl.appendChild(role);

  if (device.capabilities.length > 0) {
    const caps = document.createElement("span");
    caps.className = "fleet-caps";
    for (const chip of device.capabilities) {
      const c = document.createElement("span");
      c.className = "fleet-cap-chip";
      c.setAttribute("data-known", chip.known ? "true" : "false");
      c.textContent = chip.tag;
      caps.appendChild(c);
    }
    rowEl.appendChild(caps);
  }

  // tri-state health, keyed on data-health, paired with text (a11y: color is not the only signal).
  const health = document.createElement("span");
  health.className = "fleet-health";
  health.setAttribute("data-health", device.health);
  health.textContent = healthLabel(device.health);
  rowEl.appendChild(health);

  // last_report under the "last-seen" label.
  const seen = document.createElement("span");
  seen.className = "fleet-last-seen";
  seen.textContent = `last-seen: ${device.lastSeen}`;
  rowEl.appendChild(seen);

  return rowEl;
}

/** The single Manage affordance. Enabled ⇒ a button that posts the navigation
 *  message. Disabled (Fleet Manager tab #1322 absent) ⇒ an honestly-disabled
 *  control with no click handler — no dead click (AC3). */
function renderManage(enabled: boolean, post: (msg: OpenFleetManagerRequest) => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fleet-manage";
  btn.textContent = "Manage";
  btn.setAttribute("aria-label", "Manage fleet");
  if (enabled) {
    btn.addEventListener("click", () => post({ kind: "open-fleet-manager" }));
  } else {
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
    btn.title = "Fleet Manager is not available yet";
  }
  return btn;
}

/**
 * Render the fleet section into `container` from the view-model. Pure DOM +
 * a `post` callback (the webview passes vscode.postMessage). READ-ONLY: the
 * only message it can emit is the Manage navigation (AC4).
 */
export function renderFleetSection(
  container: HTMLElement,
  model: FleetSectionModel,
  post: (msg: OpenFleetManagerRequest) => void,
): void {
  container.innerHTML = "";

  if (model.posture) {
    container.appendChild(renderPostureBadge(model.posture));
  }

  if (model.state === "populated") {
    const list = document.createElement("div");
    list.className = "fleet-device-list";
    for (const device of model.devices) {
      list.appendChild(renderDeviceRow(device));
    }
    container.appendChild(list);
  } else if (model.state === "empty") {
    // Honest empty state — the fleet is reachable, no devices are reporting.
    // Never a spinner or a fabricated list.
    const empty = document.createElement("div");
    empty.className = "fleet-empty fleet-placeholder-text";
    empty.textContent = "No devices reporting yet";
    container.appendChild(empty);
  } else {
    // Honest degraded state — the roster host is unreachable. Never a spinner
    // and never a stale/fabricated device list.
    const down = document.createElement("div");
    down.className = "fleet-unreachable fleet-placeholder-text";
    down.textContent = "Fleet host unreachable";
    container.appendChild(down);
  }

  // The single, section-level Manage affordance — read-only navigation to the
  // Fleet Manager tab (#1322), rendered in every state; honestly disabled when
  // that tab is absent (no dead click, AC3).
  container.appendChild(renderManage(model.manage.enabled, post));
}
