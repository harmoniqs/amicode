import { describe, expect, test } from "bun:test"
import {
  capabilityChip,
  shapeFleetDeviceRows,
  buildCapabilitiesReport,
  fleetManagerCommand,
  transportPrefill,
  TRANSPORT_OPTIONS,
  enrollAction,
  CREATE_FLEET_COMMAND,
  fleetTransportMessage,
  shapeVersionRows,
  type RosterRowLike,
} from "./fleet-manager"

const row = (over: Partial<RosterRowLike> = {}): RosterRowLike => ({
  machine_id: "mac-studio-01",
  name: "Mac Studio",
  server_mode: "server",
  capabilities: ["compute", "roaming"],
  sshAlias: "mac-studio",
  transport: "ssh",
  last_report: "2026-09-20T12:00:00.000Z",
  health: "reachable",
  ...over,
})

describe("shapeFleetDeviceRows (AC2 — roster JSON → rendered rows)", () => {
  test("maps each roster row to a device row: name, role (server_mode), health, last-seen", () => {
    const rows = shapeFleetDeviceRows({ rows: [row({ machine_id: "a", name: "Alpha" })], localMachineId: "a" })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe("Alpha")
    expect(rows[0].role).toBe("server") // server_mode, surfaced as the "role" label
    expect(rows[0].health).toBe("reachable")
    expect(rows[0].lastSeen).toBe("2026-09-20T12:00:00.000Z")
    expect(rows[0].transport).toBe("ssh")
  })

  test("only THIS machine's own row is editable (single-writer, ADR 0026)", () => {
    const rows = shapeFleetDeviceRows({
      rows: [row({ machine_id: "a" }), row({ machine_id: "b" })],
      localMachineId: "a",
    })
    expect(rows[0].editable).toBe(true)
    expect(rows[1].editable).toBe(false)
  })

  test("no local machine known ⇒ no row is editable", () => {
    const rows = shapeFleetDeviceRows({ rows: [row({ machine_id: "a" })], localMachineId: null })
    expect(rows[0].editable).toBe(false)
  })
})

describe("capabilityChip (AC2 — known/descriptive split; compute not-yet-wired)", () => {
  test("compute is known but NOT wired — the honest not-yet-wired affordance (drives no solve routing)", () => {
    const chip = capabilityChip("compute")
    expect(chip.known).toBe(true)
    expect(chip.wired).toBe(false)
    expect(chip.note).toBe("not yet wired")
  })

  test("roaming is known AND wired (it defaults transport), no not-yet-wired note", () => {
    const chip = capabilityChip("roaming")
    expect(chip.known).toBe(true)
    expect(chip.wired).toBe(true)
    expect(chip.note).toBeUndefined()
  })

  test("an arbitrary descriptive tag round-trips verbatim, marked not-known and unwired", () => {
    expect(capabilityChip("gpu-rig")).toEqual({ tag: "gpu-rig", known: false, wired: false })
  })

  test("shaped rows carry the compute not-yet-wired chip", () => {
    const rows = shapeFleetDeviceRows({ rows: [row({ capabilities: ["compute", "gpu-rig"] })], localMachineId: null })
    const compute = rows[0].capabilities.find((c) => c.tag === "compute")!
    expect(compute.wired).toBe(false)
    expect(compute.note).toBe("not yet wired")
  })
})

describe("buildCapabilitiesReport (AC2 — local-row capabilities edit → POST /amicode/roster body)", () => {
  test("replaces ONLY capabilities; role (server_mode) and identity are preserved", () => {
    const body = buildCapabilitiesReport(row({ machine_id: "a", server_mode: "server" }), ["compute", "gpu-rig"])
    expect(body.capabilities).toEqual(["compute", "gpu-rig"])
    // server_mode is the reconciled fleet.json mirror — NEVER edited from the chip editor (ADR 0026)
    expect(body.server_mode).toBe("server")
    expect(body.machine_id).toBe("a")
    // the rest of the row rides through unchanged (a well-formed RosterRow for POST /amicode/roster)
    expect(body.name).toBe("Mac Studio")
    expect(body.health).toBe("reachable")
    expect(body.sshAlias).toBe("mac-studio")
  })

  test("does not mutate the input row's capabilities array", () => {
    const input = row({ capabilities: ["compute"] })
    buildCapabilitiesReport(input, ["compute", "roaming"])
    expect(input.capabilities).toEqual(["compute"])
  })
})

describe("fleetManagerCommand (AC3/AC4 — buttons invoke EXISTING registered commands)", () => {
  test("This-machine + Hub actions map to the exact registered command strings", () => {
    // These are the commands already registered in the extension (extension.ts):
    // the tab INVOKES them, it does not reimplement their logic.
    expect(fleetManagerCommand("repair")).toBe("amicode.fleet.repair")
    expect(fleetManagerCommand("goStandalone")).toBe("amicode.fleet.goStandalone")
    expect(fleetManagerCommand("restartHub")).toBe("amicode.restartHub")
  })
})

describe("transportPrefill (AC3 — transport selector prefill)", () => {
  test("a roaming-tagged machine prefills to tailscale", () => {
    expect(transportPrefill({ capabilities: ["compute", "roaming"], transport: "ssh" })).toBe("tailscale")
  })

  test("a non-roaming machine keeps its recorded transport", () => {
    expect(transportPrefill({ capabilities: ["compute"], transport: "ssh" })).toBe("ssh")
  })

  test("a non-roaming machine with no recorded transport falls back to the ssh default", () => {
    expect(transportPrefill({ capabilities: [], transport: "" })).toBe("ssh")
    expect(transportPrefill({ capabilities: [] })).toBe("ssh")
  })

  test("the selector offers the known transport providers", () => {
    expect(TRANSPORT_OPTIONS).toContain("ssh")
    expect(TRANSPORT_OPTIONS).toContain("tailscale")
  })

  test("a transport selection rides a value-bearing bridge envelope (writes amicode.fleetTransport)", () => {
    expect(fleetTransportMessage("tailscale")).toEqual({
      source: "amicode",
      kind: "fleet-set-transport",
      value: "tailscale",
    })
  })
})

describe("enrollAction (AC6 — Enroll degrades honestly)", () => {
  test("launches /create-a-fleet when the skill is present", () => {
    expect(enrollAction({ hasCreateFleetSkill: true })).toEqual({ available: true, launch: CREATE_FLEET_COMMAND })
    expect(CREATE_FLEET_COMMAND).toBe("/create-a-fleet")
  })

  test("shows an honest not-yet-available state and launches NOTHING when absent (#1320 not built on this branch)", () => {
    const action = enrollAction({ hasCreateFleetSkill: false })
    expect(action.available).toBe(false)
    expect(action.launch).toBeUndefined()
  })
})

describe("shapeVersionRows (AC5 — Versions renders the retired panel's doctor content)", () => {
  test("maps doctor surfaces to version rows; null version → the honest '—' absence marker", () => {
    const rows = shapeVersionRows({
      surfaces: [
        { surface: "extension", version: "0.3.6", source_version: "0.3.6", verdict: "current" },
        { surface: "staged-skills", version: null, source_version: null, verdict: "unknown" },
      ],
    })
    expect(rows).toEqual([
      { surface: "extension", version: "0.3.6", sourceVersion: "0.3.6", verdict: "current" },
      { surface: "staged-skills", version: "—", sourceVersion: "—", verdict: "unknown" },
    ])
  })

  test("no report ⇒ no rows (honest empty, never fabricated)", () => {
    expect(shapeVersionRows(null)).toEqual([])
    expect(shapeVersionRows(undefined)).toEqual([])
  })
})
