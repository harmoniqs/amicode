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
