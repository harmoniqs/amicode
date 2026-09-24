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
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  type SessionProvenance,
  type SessionOwnerTag,
  type FleetSessionEntry,
  resolveSessionProvenance,
  provenanceMenuItems,
  mapOwnerTagToProvenanceInput,
  fleetSessionsFromResponse,
  resolveHeaderProvenance,
  type ProvenanceMenuAction,
  type ProvenanceMenuInfo,
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
    const infoItems = items.filter((i): i is ProvenanceMenuInfo => i.kind === "info")
    const machineItem = infoItems.find((i) => i.label === "Machine")
    const wsItem = infoItems.find((i) => i.label === "Workspace")
    const branchItem = infoItems.find((i) => i.label === "Branch")
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

// ── #1452 W4a — session-header mount (fetch → map → resolve → render) ─────────
// The live header fetches GET /amicode/fleet/sessions (W2 #1447), finds THIS
// session's amicode_owner overlay, maps it to a SessionProvenanceInput, and
// resolves the icon. These cover the pure fetch→map→resolve pipeline the header
// consumes; the render itself is a structural guard (the SolidJS wiring in
// message-timeline.tsx is untested-by-design, per the app's convention).

describe("mapOwnerTagToProvenanceInput (#1452 W4a)", () => {
  test("maps a remote owner tag onto the provenance input verbatim", () => {
    const tag: SessionOwnerTag = {
      owner_machine_id: "mac-studio",
      owner_name: "Mac Studio",
      device_type: "desktop",
      is_local: false,
    }
    expect(mapOwnerTagToProvenanceInput(tag)).toEqual({
      ownerMachineId: "mac-studio",
      ownerMachineName: "Mac Studio",
      isLocal: false,
    })
  })

  test("a local owner tag maps to a local (no-icon) input", () => {
    const tag: SessionOwnerTag = {
      owner_machine_id: "macbook",
      owner_name: "MacBook",
      is_local: true,
    }
    expect(mapOwnerTagToProvenanceInput(tag).isLocal).toBe(true)
  })

  test("a missing owner tag (legacy/local path) degrades to a local input", () => {
    expect(mapOwnerTagToProvenanceInput(undefined)).toEqual({
      ownerMachineId: undefined,
      ownerMachineName: undefined,
      isLocal: true,
    })
  })
})

describe("fleetSessionsFromResponse (#1452 W4a)", () => {
  test("reads the projection's sessions[] with their amicode_owner overlay", () => {
    const raw = {
      ok: true,
      mode: "fleet",
      sessions: [
        {
          id: "ses_remote",
          title: "Remote",
          amicode_owner: { owner_machine_id: "mac-studio", owner_name: "Mac Studio", is_local: false },
        },
        { id: "ses_legacy", title: "Legacy" },
      ],
    }
    const out = fleetSessionsFromResponse(raw)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      id: "ses_remote",
      amicode_owner: { owner_machine_id: "mac-studio", owner_name: "Mac Studio", is_local: false },
    })
    expect(out[1]).toEqual({ id: "ses_legacy" })
  })

  test("a failed / malformed response (undefined) yields an empty list — never throws", () => {
    expect(fleetSessionsFromResponse(undefined)).toEqual([])
    expect(fleetSessionsFromResponse({})).toEqual([])
    expect(fleetSessionsFromResponse({ sessions: "nope" })).toEqual([])
  })

  test("rows without a string id, and malformed owner tags, are dropped tolerantly", () => {
    const raw = {
      sessions: [
        { id: 123 }, // non-string id → dropped
        { id: "ses_ok", amicode_owner: { owner_machine_id: "m", owner_name: "M", is_local: false } },
        { id: "ses_badowner", amicode_owner: { owner_machine_id: 7 } }, // bad tag → id kept, owner dropped
      ],
    }
    const out = fleetSessionsFromResponse(raw)
    expect(out.map((s) => s.id)).toEqual(["ses_ok", "ses_badowner"])
    expect(out.find((s) => s.id === "ses_badowner")?.amicode_owner).toBeUndefined()
  })
})

describe("resolveHeaderProvenance (#1452 W4a) — the header's fetch→resolve pipeline", () => {
  test("a stubbed projection with one remote-owned session drives showIcon=true, tooltip=owner_name", () => {
    const sessions: FleetSessionEntry[] = [
      {
        id: "ses_current",
        amicode_owner: { owner_machine_id: "mac-studio", owner_name: "Mac Studio", is_local: false },
      },
    ]
    const p = resolveHeaderProvenance(sessions, "ses_current")
    expect(p.showIcon).toBe(true)
    expect(p.tooltip).toBe("Mac Studio")
    expect(p.isRemote).toBe(true)
  })

  test("a legacy session with no owner tag degrades to today's no-provenance header", () => {
    const sessions: FleetSessionEntry[] = [{ id: "ses_current" }]
    const p = resolveHeaderProvenance(sessions, "ses_current")
    expect(p.showIcon).toBe(false)
    expect(p.isRemote).toBe(false)
  })

  test("a locally-owned session shows no icon", () => {
    const sessions: FleetSessionEntry[] = [
      { id: "ses_current", amicode_owner: { owner_machine_id: "macbook", owner_name: "MacBook", is_local: true } },
    ]
    expect(resolveHeaderProvenance(sessions, "ses_current").showIcon).toBe(false)
  })

  test("a session id absent from the projection degrades to no icon (never a bogus owner)", () => {
    const sessions: FleetSessionEntry[] = [
      { id: "ses_other", amicode_owner: { owner_machine_id: "mac-studio", owner_name: "Mac Studio", is_local: false } },
    ]
    expect(resolveHeaderProvenance(sessions, "ses_current").showIcon).toBe(false)
  })

  test("an undefined projection (fetch not yet resolved / failed) degrades to no icon", () => {
    expect(resolveHeaderProvenance(undefined, "ses_current").showIcon).toBe(false)
  })

  test("an undefined current session id resolves to no icon", () => {
    const sessions: FleetSessionEntry[] = [
      { id: "ses_current", amicode_owner: { owner_machine_id: "mac-studio", owner_name: "Mac Studio", is_local: false } },
    ]
    expect(resolveHeaderProvenance(sessions, undefined).showIcon).toBe(false)
  })
})

describe("session-header provenance icon is MOUNTED in the live header (#1452 W4a AC1+AC2)", () => {
  // Structural guard (the app's convention for the untested-by-design SolidJS
  // wiring — mirrors vscode-explorer-file-icon.test.tsx). This is BOTH the AC2
  // dead-module guard (a live, non-test importer) AND the AC1 wiring proof (the
  // header fetches the projection and renders the resolved provenance icon).
  const source = readFileSync(resolve(__dirname, "message-timeline.tsx"), "utf8")

  test("message-timeline imports resolveHeaderProvenance from ./session-header-provenance (live importer)", () => {
    expect(source).toContain('from "./session-header-provenance"')
    expect(source).toContain("resolveHeaderProvenance")
  })

  test("message-timeline fetches the fleet-sessions projection the header maps", () => {
    expect(source).toContain('"/amicode/fleet/sessions"')
    expect(source).toContain("fleetSessionsFromResponse")
  })

  test("message-timeline renders the provenance icon gated on the resolved showIcon", () => {
    expect(source).toContain('data-slot="session-provenance-icon"')
    // the icon is gated on the resolved provenance's showIcon and tooltip
    expect(source).toMatch(/sessionProvenance\(\)\.showIcon/)
    expect(source).toMatch(/sessionProvenance\(\)\.tooltip/)
  })
})
