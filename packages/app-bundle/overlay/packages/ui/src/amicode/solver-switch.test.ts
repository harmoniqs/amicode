import { describe, expect, test } from "bun:test"
import {
  SOLVER_SWITCH_MAX_MS,
  SOLVER_SWITCH_STALL_MS,
  solverModeName,
  solverSwitchExpired,
  solverSwitchLabel,
  solverSwitchPhase,
} from "./solver-switch"

describe("solver switch phase", () => {
  test("no target is idle, connected or not", () => {
    expect(solverSwitchPhase({ target: undefined, connected: true, sawDrop: false })).toBe("idle")
    expect(solverSwitchPhase({ target: undefined, connected: false, sawDrop: true })).toBe("idle")
  })

  test("requested → restarting → ready over one switch", () => {
    const target = "piccolo" as const
    expect(solverSwitchPhase({ target, connected: true, sawDrop: false })).toBe("requested")
    expect(solverSwitchPhase({ target, connected: false, sawDrop: false })).toBe("restarting")
    expect(solverSwitchPhase({ target, connected: true, sawDrop: true })).toBe("ready")
  })

  test("a drop while still down stays restarting — sawDrop does not short-circuit it", () => {
    expect(solverSwitchPhase({ target: "hp", connected: false, sawDrop: true })).toBe("restarting")
  })
})

describe("solver switch expiry", () => {
  test("a request that never drops the server is abandoned", () => {
    expect(solverSwitchExpired("requested", SOLVER_SWITCH_STALL_MS - 1)).toBe(false)
    expect(solverSwitchExpired("requested", SOLVER_SWITCH_STALL_MS + 1)).toBe(true)
  })

  test("a restart gets the full ceiling, not the stall window", () => {
    expect(solverSwitchExpired("restarting", SOLVER_SWITCH_STALL_MS + 1)).toBe(false)
    expect(solverSwitchExpired("restarting", SOLVER_SWITCH_MAX_MS + 1)).toBe(true)
  })

  test("idle and ready never expire — the caller clears those", () => {
    expect(solverSwitchExpired("idle", SOLVER_SWITCH_MAX_MS * 10)).toBe(false)
    expect(solverSwitchExpired("ready", SOLVER_SWITCH_MAX_MS * 10)).toBe(false)
  })
})

describe("solver switch copy", () => {
  test("names match the capsule's own labels", () => {
    expect(solverModeName("hp")).toBe("Piccolissimo + Altissimo")
    expect(solverModeName("piccolo")).toBe("Piccolo")
  })

  test("every visible phase reads as an upgrade, never as a fault", () => {
    expect(solverSwitchLabel("requested", "hp")).toBe("Switching to Piccolissimo + Altissimo…")
    expect(solverSwitchLabel("restarting", "hp")).toBe("Restarting session server…")
    expect(solverSwitchLabel("ready", "piccolo")).toBe("Piccolo ready")
    expect(solverSwitchLabel("restarting", "hp")).not.toMatch(/drop|lost|error|fail/i)
  })

  test("idle and targetless render nothing", () => {
    expect(solverSwitchLabel("idle", "hp")).toBeUndefined()
    expect(solverSwitchLabel("ready", undefined)).toBeUndefined()
  })
})
