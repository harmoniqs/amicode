// fleet-manager.ts — the Fleet Manager Work Column tab's PURE logic (#1322,
// ADR 0026). Self-contained + browser-safe (no node imports): it runs in the
// SolidJS app, so — like sidebar_fleet_section.ts on the extension side — it
// re-declares the tiny slice of the @amicode/schema roster vocabulary it needs
// rather than importing across the node seam.
//
// What lives here (and is unit-tested), NOT the component render:
//   - shapeFleetDeviceRows(): roster JSON → rendered device rows (role, health,
//     last-seen, capability chips, single-writer editability).
//   - capabilityChip(): a tag → known/descriptive + wired/not-yet-wired chip
//     (the `compute` chip is the honest "not yet wired" affordance).
//   - buildCapabilitiesReport(): the LOCAL row's capabilities edit → the POST
//     /amicode/roster body (server_mode/role is NEVER edited from here).
//   - fleetManagerCommand(): the This-machine / Hub buttons' existing command
//     strings (invoked, not reimplemented).
//   - transportPrefill(): the transport selector's prefill (roaming → tailscale).
//   - enrollAction(): the Enroll affordance's honest present/absent degradation.

/** The per-device reachability tri-state (schema HEALTH_VOCABULARY, #1318). */
export type RosterHealth = "reachable" | "degraded" | "down"

/** The KNOWN behavior-adjacent capability tags (schema KNOWN_CAPABILITY_TAGS,
 *  ADR 0026 §1). Any OTHER tag is a valid descriptive label (known:false). */
const KNOWN_CAPABILITY_TAGS = ["compute", "roaming"] as const
/** Capabilities carrying ACTIVE behavior today. `roaming` is wired (it defaults
 *  transport to tailscale); `compute` is declared-but-inert — the honest
 *  "not yet wired" case (enabling it drives NO solve routing). */
const WIRED_CAPABILITY_TAGS = ["roaming"] as const

/** The structural roster-row shape this module consumes (the @amicode/schema
 *  RosterRow — accepted structurally so the host can pass real parsed rows and
 *  tests can pass literals, without a node import). */
export interface RosterRowLike {
  machine_id: string
  name: string
  server_mode: string
  capabilities: string[]
  sshAlias?: string
  transport?: string
  last_report: string
  health: RosterHealth
}

/** A capability tag shaped for the chip UI. */
export interface FleetCapabilityChip {
  tag: string
  /** true for the behavior-adjacent tags (compute, roaming). */
  known: boolean
  /** false ⇒ no active behavior yet; `compute` is the honest not-yet-wired case. */
  wired: boolean
  /** an honest affordance note for a known-but-inert capability (compute). */
  note?: string
}

/** Shape ONE capability tag into its chip (known/descriptive + wired state). */
export function capabilityChip(tag: string): FleetCapabilityChip {
  const known = (KNOWN_CAPABILITY_TAGS as readonly string[]).includes(tag)
  const wired = (WIRED_CAPABILITY_TAGS as readonly string[]).includes(tag)
  const chip: FleetCapabilityChip = { tag, known, wired }
  // The compute chip is declared-but-inert — surface it honestly.
  if (tag === "compute") chip.note = "not yet wired"
  return chip
}

/** One rendered device row (roster row after display-labelling). */
export interface FleetManagerDeviceRow {
  machineId: string
  name: string
  /** server_mode, surfaced under the "role" label — READ-ONLY here. */
  role: string
  capabilities: FleetCapabilityChip[]
  health: RosterHealth
  /** last_report, surfaced under the "last-seen" label. */
  lastSeen: string
  transport: string
  /** true only for THIS machine's own row — single-writer: only the local
   *  row's capabilities are editable here (ADR 0026). */
  editable: boolean
}

/** Roster JSON → rendered device rows. Pure. `localMachineId` marks which row
 *  (if any) is this machine's own — the only editable one. */
export function shapeFleetDeviceRows(input: {
  rows: RosterRowLike[]
  localMachineId: string | null
}): FleetManagerDeviceRow[] {
  return input.rows.map((r) => ({
    machineId: r.machine_id,
    name: r.name,
    role: r.server_mode,
    capabilities: r.capabilities.map(capabilityChip),
    health: r.health,
    lastSeen: r.last_report,
    transport: r.transport ?? "",
    editable: input.localMachineId !== null && r.machine_id === input.localMachineId,
  }))
}

/** The POST /amicode/roster body for the LOCAL row's capabilities edit. The row
 *  is carried whole with ONLY `capabilities` replaced — `server_mode` (role) is
 *  the reconciled fleet.json mirror and is never edited from here (ADR 0026),
 *  and every other field rides through so the body is a well-formed RosterRow. */
export function buildCapabilitiesReport(localRow: RosterRowLike, nextCapabilities: string[]): RosterRowLike {
  return { ...localRow, capabilities: [...nextCapabilities] }
}

// ── This-machine / Hub actions → existing registered commands ────────────────

/** The tab's command-invoking actions. The tab INVOKES these existing commands
 *  (via the app→extension bridge, postAmicode) — it never reimplements their
 *  logic (Key Decision: "the commands stay registered in the Command Palette").
 *  `repair` + `goStandalone` are This-machine actions; `restartHub` is the Hub
 *  service action (server only). */
export type FleetManagerAction = "repair" | "goStandalone" | "restartHub"

const FLEET_MANAGER_COMMANDS: Record<FleetManagerAction, string> = {
  repair: "amicode.fleet.repair",
  goStandalone: "amicode.fleet.goStandalone",
  restartHub: "amicode.restartHub",
}

/** The EXISTING registered command string a This-machine / Hub button invokes. */
export function fleetManagerCommand(action: FleetManagerAction): string {
  return FLEET_MANAGER_COMMANDS[action]
}

// ── This machine: transport selector ─────────────────────────────────────────

/** The default transport when a machine has no recorded/roaming hint. */
export const TRANSPORT_DEFAULT = "ssh"

/** The transport providers the selector offers (writes `amicode.fleetTransport`). */
export const TRANSPORT_OPTIONS = ["ssh", "tailscale", "local"] as const

/** The transport selector's prefill: a `roaming`-tagged machine defaults to
 *  tailscale (ADR 0026 §1); otherwise the machine's recorded transport, else the
 *  ssh default. No silent reroute — this is only the SELECTOR's initial value. */
export function transportPrefill(input: { capabilities: string[]; transport?: string }): string {
  if (input.capabilities.includes("roaming")) return "tailscale"
  return input.transport && input.transport.trim() !== "" ? input.transport : TRANSPORT_DEFAULT
}

// ── Enroll: launch /create-a-fleet, or degrade honestly when it is absent ────

/** The slash-command the Enroll action launches when the orchestrator (#1320)
 *  is present. */
export const CREATE_FLEET_COMMAND = "/create-a-fleet"

/** The Enroll affordance's resolved state. `available` ⇒ launch the command;
 *  otherwise the honest not-yet-available state (launches NOTHING) — the live
 *  wiring lands when #1320 / `/create-a-fleet` ships. */
export interface EnrollAction {
  available: boolean
  /** the slash-command to launch — present only when available. */
  launch?: string
}

/** Resolve the Enroll action honestly: launch `/create-a-fleet` when the skill
 *  is present, else the not-yet-available state that launches nothing (AC6). */
export function enrollAction(input: { hasCreateFleetSkill: boolean }): EnrollAction {
  if (input.hasCreateFleetSkill) return { available: true, launch: CREATE_FLEET_COMMAND }
  return { available: false }
}

// ── This machine: the transport write envelope (app → extension bridge) ──────

/** The app→extension message that writes the `amicode.fleetTransport` setting.
 *  The command bridge (postAmicode) carries no argument, so a transport SELECTION
 *  (which must carry a value) rides its own value-bearing envelope; the extension
 *  chat bridge writes the config from it. No silent reroute — the selector's
 *  change is an explicit, honest write (ADR 0024/0025). */
export interface FleetTransportMessage {
  source: "amicode"
  kind: "fleet-set-transport"
  value: string
}

export function fleetTransportMessage(value: string): FleetTransportMessage {
  return { source: "amicode", kind: "fleet-set-transport", value }
}

// ── Versions: the retired Fleet & Versions panel's doctor content ────────────

/** A doctor surface record (structural — the extension ships this in the
 *  open-fleet-manager message; matches fleet_panel.ts FleetSurfaceRecord). */
export interface DoctorSurfaceLike {
  surface: string
  version: string | null
  source_version: string | null
  verdict: string
}

/** One rendered version row — a surface's running/source version + verdict. */
export interface FleetVersionRow {
  surface: string
  version: string
  sourceVersion: string
  verdict: string
}

/** The doctor absence marker — the same "—" doctor's own human table uses. */
const VERSION_NULL_MARKER = "—"

/** Doctor report → version rows for the tab's Versions section. Null version
 *  fields render as the honest absence marker; a missing report ⇒ no rows
 *  (never a fabricated list). This is the content the retired panel showed. */
export function shapeVersionRows(
  report: { surfaces: DoctorSurfaceLike[] } | null | undefined,
): FleetVersionRow[] {
  if (!report || !Array.isArray(report.surfaces)) return []
  return report.surfaces.map((s) => ({
    surface: s.surface,
    version: s.version ?? VERSION_NULL_MARKER,
    sourceVersion: s.source_version ?? VERSION_NULL_MARKER,
    verdict: s.verdict,
  }))
}




