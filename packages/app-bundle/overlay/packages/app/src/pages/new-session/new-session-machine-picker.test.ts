/**
 * new-session-machine-picker.test.ts — #1442 AC4
 *
 * Tests the pure-logic module for the new-session machine picker cascade:
 *   Machine ▸ Project ▸ Worktree — Machine first, default = focused machine
 *   (from fleet_focus.ts). The create call carries machine_id.
 */
import { describe, expect, test } from "bun:test"
import {
  type MachinePickerState,
  createMachinePickerState,
  type MachineOption,
} from "../../components/new-session-machine-picker"

describe("new-session machine picker (#1442 AC4)", () => {
  const machines: MachineOption[] = [
    { machineId: "local-001", name: "MacBook Pro", isLocal: true },
    { machineId: "studio-001", name: "Mac Studio", isLocal: false },
    { machineId: "server-001", name: "Build Server", isLocal: false },
  ]

  test("machine selector is first in the cascade (before project/worktree)", () => {
    const state = createMachinePickerState({
      machines,
      focusedMachineId: undefined,
    })
    // The cascade order is: machine → project → worktree
    expect(state.cascadeOrder).toEqual(["machine", "project", "worktree"])
  })

  test("default selected machine is the focused machine from fleet_focus", () => {
    const state = createMachinePickerState({
      machines,
      focusedMachineId: "studio-001",
    })
    expect(state.selectedMachineId).toBe("studio-001")
  })

  test("when no machine is focused, default is the local machine", () => {
    const state = createMachinePickerState({
      machines,
      focusedMachineId: undefined,
    })
    expect(state.selectedMachineId).toBe("local-001")
  })

  test("selecting a machine updates the state", () => {
    const state = createMachinePickerState({
      machines,
      focusedMachineId: undefined,
    })
    state.selectMachine("server-001")
    expect(state.selectedMachineId).toBe("server-001")
  })

  test("the create payload carries the selected machine_id", () => {
    const state = createMachinePickerState({
      machines,
      focusedMachineId: "studio-001",
    })
    const payload = state.createPayload()
    expect(payload.machine_id).toBe("studio-001")
  })

  test("after selecting a different machine, the create payload reflects the change", () => {
    const state = createMachinePickerState({
      machines,
      focusedMachineId: "studio-001",
    })
    state.selectMachine("server-001")
    const payload = state.createPayload()
    expect(payload.machine_id).toBe("server-001")
  })

  test("machines list is available for rendering the selector", () => {
    const state = createMachinePickerState({
      machines,
      focusedMachineId: undefined,
    })
    expect(state.machines).toEqual(machines)
  })
})
