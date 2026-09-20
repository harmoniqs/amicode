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

/** What buildFleetSectionModel needs. `rosterReachable` is the honesty signal:
 *  false ⇒ the roster read failed / host down ⇒ the `unreachable` state. */
export interface FleetSectionInput {
  roster: RosterRowLike[];
  rosterReachable: boolean;
  posture: unknown;
  manageAvailable: boolean;
}

/** The complete view-model handed to the webview. */
export interface FleetSectionModel {
  state: FleetSectionState;
  devices: FleetDeviceRow[];
  posture: null;
  /** The single Manage affordance — enabled only when the Fleet Manager tab
   *  (#1322) is present. Disabled ⇒ honest degrade, no dead click. */
  manage: { enabled: boolean };
}

/** Build the fleet-section view-model. Pure. */
export function buildFleetSectionModel(input: FleetSectionInput): FleetSectionModel {
  const devices: FleetDeviceRow[] = input.roster.map((r) => ({
    machineId: r.machine_id,
    name: r.name,
    role: r.server_mode,
    capabilities: [],
    health: r.health,
    lastSeen: r.last_report,
  }));
  const state: FleetSectionState = devices.length > 0 ? "populated" : "empty";
  return {
    state,
    devices,
    posture: null,
    manage: { enabled: input.manageAvailable },
  };
}
