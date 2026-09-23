/**
 * session-header-provenance.test.ts — #1442 AC1+AC2
 *
 * Tests the pure-logic module for session-header provenance:
 *   AC1: Remote session shows computer icon + tooltip (machine name);
 *        local session shows no icon.
 *   AC2: Provenance caret menu shows Machine · Workspace · Branch + actions;
 *        branch/worktree is read from the owner (routes through multiplexer).
 */
import { describe, expect, test } from "bun:test"
import {
  type SessionProvenance,
  resolveSessionProvenance,
  provenanceMenuItems,
  type ProvenanceMenuAction,
} from "./session-header-provenance"

describe("session-header provenance (#1442 AC1)", () => {
  test("a remote session resolves to a provenance with icon + tooltip = machine name", () => {
    const p = resolveSessionProvenance({
      ownerMachineId: "mac-studio-001",
      ownerMachineName: "Mac Studio",
      isLocal: false,
    })
    expect(p.showIcon).toBe(true)
    expect(p.tooltip).toBe("Mac Studio")
    expect(p.isRemote).toBe(true)
  })

  test("a local session resolves to no icon", () => {
    const p = resolveSessionProvenance({
      ownerMachineId: "local-machine",
      ownerMachineName: "This Machine",
      isLocal: true,
    })
    expect(p.showIcon).toBe(false)
    expect(p.isRemote).toBe(false)
  })

  test("missing owner info (no multiplexer data) resolves to local (no icon)", () => {
    const p = resolveSessionProvenance({
      ownerMachineId: undefined,
      ownerMachineName: undefined,
      isLocal: true,
    })
    expect(p.showIcon).toBe(false)
    expect(p.isRemote).toBe(false)
  })
})

describe("session-header provenance caret menu (#1442 AC2)", () => {
  test("provenance menu shows Machine, Workspace, Branch items", () => {
    const items = provenanceMenuItems({
      machineName: "Mac Studio",
      workspace: "/home/user/project",
      branch: "main",
    })
    const labels = items.filter((i) => i.kind === "info").map((i) => i.label)
    expect(labels).toContain("Machine")
    expect(labels).toContain("Workspace")
    expect(labels).toContain("Branch")
  })

  test("provenance menu values come from the owner (not local)", () => {
    const items = provenanceMenuItems({
      machineName: "Mac Studio",
      workspace: "/home/user/remote-project",
      branch: "feature/fleet",
    })
    const machineItem = items.find((i) => i.kind === "info" && i.label === "Machine")
    const wsItem = items.find((i) => i.kind === "info" && i.label === "Workspace")
    const branchItem = items.find((i) => i.kind === "info" && i.label === "Branch")
    expect(machineItem?.value).toBe("Mac Studio")
    expect(wsItem?.value).toBe("/home/user/remote-project")
    expect(branchItem?.value).toBe("feature/fleet")
  })

  test("provenance menu includes Open folder, Copy path, and Open in Remote-SSH actions", () => {
    const items = provenanceMenuItems({
      machineName: "Mac Studio",
      workspace: "/home/user/project",
      branch: "main",
    })
    const actions = items.filter((i) => i.kind === "action").map((i) => (i as ProvenanceMenuAction).action)
    expect(actions).toContain("open-folder")
    expect(actions).toContain("copy-path")
    expect(actions).toContain("open-remote-ssh")
  })

  test("provenance menu omits branch item when branch is unknown", () => {
    const items = provenanceMenuItems({
      machineName: "Mac Studio",
      workspace: "/home/user/project",
      branch: undefined,
    })
    const branchItem = items.find((i) => i.kind === "info" && i.label === "Branch")
    expect(branchItem).toBeUndefined()
  })
})
