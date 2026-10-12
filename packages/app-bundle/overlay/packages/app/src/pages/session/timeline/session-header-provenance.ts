/**
 * session-header-provenance.ts — #1442 AC1+AC2
 *
 * Pure-logic module for session-header provenance in the `data-session-title`
 * sticky header. Resolves whether a session is remote (shows computer icon +
 * tooltip = machine name) or local (no icon), and builds the provenance caret
 * menu contents (Machine · Workspace · Branch + actions).
 *
 * The branch/worktree is read from the OWNER (routes through the slice-3
 * multiplexer — hits the owner, not local). This module is the data layer;
 * the TSX renderer consumes these functions.
 */

// ── types ────────────────────────────────────────────────────────────────────

/** Input for resolving session provenance — comes from the session's owner
 *  tag (populated by the fleet-wide projection's amicode_owner overlay). */
export interface SessionProvenanceInput {
  ownerMachineId: string | undefined
  ownerMachineName: string | undefined
  isLocal: boolean
}

/** The resolved provenance for a session header. */
export interface SessionProvenance {
  /** True when the session runs on a remote machine (show the computer icon). */
  isRemote: boolean
  /** Whether to show the provenance icon (computer icon left of title). */
  showIcon: boolean
  /** Tooltip text for the icon — the machine name. Empty for local. */
  tooltip: string
  /** The owner machine id (undefined for local). */
  machineId: string | undefined
  /** The owner machine name (undefined for local). */
  machineName: string | undefined
}

/** A provenance menu item — either an info line or an action. */
export type ProvenanceMenuItem = ProvenanceMenuInfo | ProvenanceMenuAction

export interface ProvenanceMenuInfo {
  kind: "info"
  label: "Machine" | "Workspace" | "Branch"
  value: string
}

export interface ProvenanceMenuAction {
  kind: "action"
  label: string
  action: "open-folder" | "copy-path" | "open-remote-ssh"
}

/** Input for building the provenance caret menu — the owner's metadata. */
export interface ProvenanceMenuInput {
  machineName: string
  workspace: string
  branch: string | undefined
}

/** The per-session owner overlay served on the fleet-sessions projection
 *  (W2 #1447, `merged_projection.ts` `tagSessionsWithOwner`). Absent on
 *  pre-fleet / local-path sessions. */
export interface SessionOwnerTag {
  owner_machine_id: string
  owner_name: string
  device_type?: string
  directory?: string
  is_local: boolean
}

/** A fleet-sessions projection entry, reduced to what the header needs: the
 *  session id and its optional owner overlay. */
export interface FleetSessionEntry {
  id: string
  amicode_owner?: SessionOwnerTag
}

// ── resolvers ────────────────────────────────────────────────────────────────

/** Resolve whether a session is remote or local, and what the icon should show.
 *  Local sessions (or sessions with no owner info) show no icon. */
export function resolveSessionProvenance(input: SessionProvenanceInput): SessionProvenance {
  const isRemote = !input.isLocal && !!input.ownerMachineId
  return {
    isRemote,
    showIcon: isRemote,
    tooltip: isRemote && input.ownerMachineName ? input.ownerMachineName : "",
    machineId: isRemote ? input.ownerMachineId : undefined,
    machineName: isRemote ? input.ownerMachineName : undefined,
  }
}

/** Build the provenance caret menu items. Shows Machine · Workspace · Branch
 *  (Branch omitted when unknown) + Open folder / Copy path / Open in Remote-SSH
 *  actions. All values come from the owner (not local). */
export function provenanceMenuItems(input: ProvenanceMenuInput): ProvenanceMenuItem[] {
  const items: ProvenanceMenuItem[] = [
    { kind: "info", label: "Machine", value: input.machineName },
    { kind: "info", label: "Workspace", value: input.workspace },
  ]

  if (input.branch !== undefined) {
    items.push({ kind: "info", label: "Branch", value: input.branch })
  }

  // Separator line is implicit in the renderer; actions follow info items
  items.push(
    { kind: "action", label: "Open folder", action: "open-folder" },
    { kind: "action", label: "Copy path", action: "copy-path" },
    { kind: "action", label: "Open in Remote-SSH", action: "open-remote-ssh" },
  )

  return items
}

// ── fleet-sessions mount (#1452 W4a) ─────────────────────────────────────────
// The live session header fetches GET /amicode/fleet/sessions (W2 #1447), finds
// the current session's amicode_owner overlay, maps it to a
// SessionProvenanceInput, and resolves the icon. These pure helpers are the
// data layer the message-timeline header consumes.

/** Map a session's owner overlay onto a SessionProvenanceInput. A missing tag
 *  (a pre-fleet / local-path session) degrades to a local input — no icon, no
 *  bogus owner. */
export function mapOwnerTagToProvenanceInput(tag: SessionOwnerTag | undefined): SessionProvenanceInput {
  if (!tag) return { ownerMachineId: undefined, ownerMachineName: undefined, isLocal: true }
  return {
    ownerMachineId: tag.owner_machine_id,
    ownerMachineName: tag.owner_name,
    isLocal: tag.is_local,
  }
}

/** Tolerant reader for one raw owner overlay — returns the tag only when its
 *  load-bearing fields are well-typed, else undefined (the session keeps its
 *  id, loses the bogus owner). */
function readOwnerTag(raw: unknown): SessionOwnerTag | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.owner_machine_id !== "string") return undefined
  if (typeof o.owner_name !== "string") return undefined
  if (typeof o.is_local !== "boolean") return undefined
  return {
    owner_machine_id: o.owner_machine_id,
    owner_name: o.owner_name,
    ...(typeof o.device_type === "string" ? { device_type: o.device_type } : {}),
    ...(typeof o.directory === "string" ? { directory: o.directory } : {}),
    is_local: o.is_local,
  }
}

/** Tolerant reader for the GET /amicode/fleet/sessions response → the header's
 *  reduced entry list. A malformed / error response (or a fetch that hasn't
 *  resolved) yields [] — it never throws. Reused by W4b's machine picker. */
export function fleetSessionsFromResponse(raw: unknown): FleetSessionEntry[] {
  if (!raw || typeof raw !== "object") return []
  const sessions = (raw as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions)) return []
  return sessions.flatMap((s) => {
    if (!s || typeof s !== "object") return []
    const id = (s as { id?: unknown }).id
    if (typeof id !== "string") return []
    const owner = readOwnerTag((s as { amicode_owner?: unknown }).amicode_owner)
    return [{ id, ...(owner ? { amicode_owner: owner } : {}) }]
  })
}

/** Resolve the header's provenance from the fetched projection + the current
 *  session id: find this session, map its owner overlay, resolve the icon.
 *  Session not found / no projection / no owner → today's no-provenance header
 *  (never a bogus owner). */
export function resolveHeaderProvenance(
  sessions: readonly FleetSessionEntry[] | undefined,
  currentSessionId: string | undefined,
): SessionProvenance {
  const current =
    currentSessionId && sessions ? sessions.find((s) => s.id === currentSessionId) : undefined
  return resolveSessionProvenance(mapOwnerTagToProvenanceInput(current?.amicode_owner))
}
