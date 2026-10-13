/**
 * new-session-machine-picker.ts — #1442 AC4
 *
 * Pure-logic module for the new-session machine picker cascade:
 *   Machine ▸ Project ▸ Worktree
 *
 * Machine is FIRST in the cascade. The default selected machine comes from the
 * focused machine in fleet_focus.ts. When no machine is focused, the local
 * machine is the default. The create call carries the chosen machine_id.
 *
 * This module is the data/state layer; the TSX renderer consumes it.
 */

// ── types ────────────────────────────────────────────────────────────────────

/** A machine available for selection in the new-session picker. */
export interface MachineOption {
  machineId: string
  name: string
  isLocal: boolean
}

/** The cascade order for the new-session selectors. */
export type CascadeStep = "machine" | "project" | "worktree"

/** Options for creating the machine picker state. */
export interface MachinePickerOptions {
  /** Available machines (from the fleet roster). */
  machines: MachineOption[]
  /** The currently focused machine id (from fleet_focus.ts), or undefined for
   *  home (local). */
  focusedMachineId: string | undefined
}

/** The create-session payload with the chosen machine. */
export interface CreateSessionPayload {
  machine_id: string
}

/** The machine picker state — manages selection and produces the create payload. */
export interface MachinePickerState {
  /** The cascade order: machine first, then project, then worktree. */
  readonly cascadeOrder: readonly CascadeStep[]
  /** The currently selected machine id. */
  readonly selectedMachineId: string
  /** The available machines for the selector. */
  readonly machines: readonly MachineOption[]
  /** Select a different machine by id. */
  selectMachine(machineId: string): void
  /** Build the create-session payload carrying the chosen machine_id. */
  createPayload(): CreateSessionPayload
}

// ── state factory ────────────────────────────────────────────────────────────

/** The fixed cascade order: Machine ▸ Project ▸ Worktree. */
const CASCADE_ORDER: readonly CascadeStep[] = ["machine", "project", "worktree"] as const

/** Create the machine picker state. Default selection = focused machine, or
 *  the local machine when no focus is set. */
export function createMachinePickerState(opts: MachinePickerOptions): MachinePickerState {
  const { machines, focusedMachineId } = opts

  // Resolve default: focused machine first, then the local machine, then first
  const localMachine = machines.find((m) => m.isLocal)
  const focusedMachine = focusedMachineId ? machines.find((m) => m.machineId === focusedMachineId) : undefined
  const defaultMachineId = focusedMachine?.machineId ?? localMachine?.machineId ?? machines[0]?.machineId ?? ""

  let _selectedMachineId = defaultMachineId

  return {
    cascadeOrder: CASCADE_ORDER,

    get selectedMachineId() {
      return _selectedMachineId
    },

    get machines() {
      return machines
    },

    selectMachine(machineId: string) {
      if (machines.some((m) => m.machineId === machineId)) {
        _selectedMachineId = machineId
      }
    },

    createPayload(): CreateSessionPayload {
      return { machine_id: _selectedMachineId }
    },
  }
}
