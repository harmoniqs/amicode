import { describe, expect, test } from "bun:test"
import {
  harnessSwitchPhase,
  harnessSwitchExpired,
  harnessSwitchLabel,
  HARNESS_SWITCH_STALL_MS,
  HARNESS_SWITCH_MAX_MS,
} from "./harness-switch"

// amicode#1549 — the harness banner's decision layer, the solver-switch
// twin's shape: pure helpers over two observable facts (a switch outstanding,
// has the stream dropped), so the phase contract is testable without a DOM.

describe("harnessSwitchPhase", () => {
  test("no target → idle", () => {
    expect(harnessSwitchPhase({ target: undefined, connected: true, sawDrop: false })).toBe("idle")
  })

  test("requested until the stream drops, restarting while down, ready on return", () => {
    expect(harnessSwitchPhase({ target: "telaio", connected: true, sawDrop: false })).toBe("requested")
    expect(harnessSwitchPhase({ target: "telaio", connected: false, sawDrop: false })).toBe("restarting")
    expect(harnessSwitchPhase({ target: "telaio", connected: true, sawDrop: true })).toBe("ready")
  })
})

describe("harnessSwitchExpired — never trap the user behind theater", () => {
  test("requested stalls past the stall window; restarting past the ceiling", () => {
    expect(harnessSwitchExpired("requested", HARNESS_SWITCH_STALL_MS + 1)).toBe(true)
    expect(harnessSwitchExpired("requested", HARNESS_SWITCH_STALL_MS - 1)).toBe(false)
    expect(harnessSwitchExpired("restarting", HARNESS_SWITCH_MAX_MS + 1)).toBe(true)
    expect(harnessSwitchExpired("restarting", HARNESS_SWITCH_MAX_MS - 1)).toBe(false)
    expect(harnessSwitchExpired("ready", Number.MAX_SAFE_INTEGER)).toBe(false)
  })
})

describe("harnessSwitchLabel — honest narration, one name end to end", () => {
  test("the labels narrate switching → restarting → ready", () => {
    expect(harnessSwitchLabel("requested", "telaio (subscription)")).toBe("Switching to telaio (subscription)…")
    expect(harnessSwitchLabel("restarting", "telaio (subscription)")).toBe("Restarting session server…")
    expect(harnessSwitchLabel("ready", "telaio (subscription)")).toBe("telaio (subscription) ready")
    expect(harnessSwitchLabel("idle", "telaio (subscription)")).toBeUndefined()
    expect(harnessSwitchLabel("requested", undefined)).toBeUndefined()
  })
})
