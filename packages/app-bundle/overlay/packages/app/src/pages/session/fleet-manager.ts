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
