// engine-toggle-utils.test.ts — #1598: unit tests for the engine toggle logic.
import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test"
import {
  parseEngineStateMessage,
  parseFleetRoleMessage,
  sendEngineCommand,
  engineDotClass,
  engineBannerLabel,
  latchedEngineState,
} from "./engine-toggle-utils"

describe("parseEngineStateMessage", () => {
  it("parses a valid engine-state message for each state", () => {
    expect(parseEngineStateMessage({ source: "amicode", kind: "engine-state", state: "on" })).toBe("on")
    expect(parseEngineStateMessage({ source: "amicode", kind: "engine-state", state: "booting" })).toBe("booting")
    expect(parseEngineStateMessage({ source: "amicode", kind: "engine-state", state: "off" })).toBe("off")
  })

  it("returns undefined for non-amicode messages", () => {
    expect(parseEngineStateMessage({ source: "vscode", kind: "engine-state", state: "on" })).toBeUndefined()
  })

  it("returns undefined for different amicode kinds", () => {
    expect(parseEngineStateMessage({ source: "amicode", kind: "theme", state: "on" })).toBeUndefined()
  })

  it("returns undefined for invalid state values", () => {
    expect(parseEngineStateMessage({ source: "amicode", kind: "engine-state", state: "starting" })).toBeUndefined()
  })

  // #1608 AC9: the parser accepts the new `stopping` lifecycle state so the
  // extension can narrate a deliberate off (locked/grayed) before the kill.
  it("parses the `stopping` state (#1608)", () => {
    expect(parseEngineStateMessage({ source: "amicode", kind: "engine-state", state: "stopping" })).toBe("stopping")
  })

  it("returns undefined for non-object input", () => {
    expect(parseEngineStateMessage(null)).toBeUndefined()
    expect(parseEngineStateMessage("string")).toBeUndefined()
    expect(parseEngineStateMessage(42)).toBeUndefined()
  })
})

describe("parseFleetRoleMessage", () => {
  it("parses valid fleet-role messages", () => {
    expect(parseFleetRoleMessage({ source: "amicode", kind: "fleet-role", role: "standalone" })).toBe("standalone")
    expect(parseFleetRoleMessage({ source: "amicode", kind: "fleet-role", role: "server" })).toBe("server")
    expect(parseFleetRoleMessage({ source: "amicode", kind: "fleet-role", role: "client" })).toBe("client")
  })

  it("returns undefined for non-amicode messages", () => {
    expect(parseFleetRoleMessage({ source: "vscode", kind: "fleet-role", role: "client" })).toBeUndefined()
  })

  it("returns undefined for invalid roles", () => {
    expect(parseFleetRoleMessage({ source: "amicode", kind: "fleet-role", role: "unknown" })).toBeUndefined()
  })
})

describe("sendEngineCommand", () => {
  let posted: unknown[]
  const originalParent = globalThis.window

  beforeEach(() => {
    posted = []
    // Mock window.parent.postMessage
    if (typeof globalThis.window === "undefined") {
      ;(globalThis as any).window = {}
    }
    ;(globalThis.window as any).parent = {
      postMessage: (msg: unknown, _target: string) => {
        posted.push(msg)
      },
    }
  })

  afterEach(() => {
    // Restore
    if (originalParent === undefined) {
      delete (globalThis as any).window
    }
  })

  it("sends amicode.stopServer when engine is on", () => {
    sendEngineCommand("on")
    expect(posted).toHaveLength(1)
    expect(posted[0]).toEqual({
      source: "amicode",
      kind: "command",
      command: "amicode.stopServer",
    })
  })

  it("sends amicode.restartServer when engine is off", () => {
    sendEngineCommand("off")
    expect(posted).toHaveLength(1)
    expect(posted[0]).toEqual({
      source: "amicode",
      kind: "command",
      command: "amicode.restartServer",
    })
  })

  it("does nothing when engine is booting (locked)", () => {
    sendEngineCommand("booting")
    expect(posted).toHaveLength(0)
  })

  // #1608 AC9: `stopping` is a locked transitional state — no command fires.
  it("does nothing when engine is stopping (locked) (#1608)", () => {
    sendEngineCommand("stopping")
    expect(posted).toHaveLength(0)
  })
})

// #1608 AC4: the engine dot renders from an EXHAUSTIVE switch. `stopping` and
// `booting` both read warning (grayed/locked); a future state that isn't
// handled is a compile error (assertNever), not a silent grey dot.
describe("engineDotClass (#1608)", () => {
  it("maps each lifecycle state to its dot token", () => {
    expect(engineDotClass("on")).toBe("bg-icon-success-base")
    expect(engineDotClass("booting")).toBe("bg-icon-warning-base")
    expect(engineDotClass("stopping")).toBe("bg-icon-warning-base")
    expect(engineDotClass("off")).toBe("bg-border-weak-base")
  })
})

// #1608 AC2 + AC8: the calm banner narrates off/stopping/booting, stays silent
// when the engine is on, and NEVER narrates on a fleet-client window (the
// engine is remote; a local "off" would be a lie).
describe("engineBannerLabel (#1608)", () => {
  it("narrates the non-on lifecycle states on a standalone/server window", () => {
    expect(engineBannerLabel("off", "standalone")).toBe("Engine off — toggle on to resume")
    expect(engineBannerLabel("stopping", "standalone")).toBe("Stopping the engine…")
    expect(engineBannerLabel("booting", "server")).toBe("Starting the engine…")
  })

  it("stays silent when the engine is on", () => {
    expect(engineBannerLabel("on", "standalone")).toBeUndefined()
  })

  it("stays silent on a fleet-client window for EVERY state (AC8)", () => {
    for (const s of ["on", "off", "stopping", "booting"] as const) {
      expect(engineBannerLabel(s, "client")).toBeUndefined()
    }
  })
})

// #1608 AC5: the local "stop-requested" latch flips the toggle to `stopping`
// the instant the user clicks, before any extension round-trip — but only
// while the raw pushed state is still `on`. Once a real push lands the caller
// clears the latch and the push wins.
describe("latchedEngineState (#1608 AC5)", () => {
  it("reads `stopping` on a click while raw is still on (instant feedback)", () => {
    expect(latchedEngineState("on", true)).toBe("stopping")
  })

  it("passes raw through when the latch is clear", () => {
    expect(latchedEngineState("on", false)).toBe("on")
    expect(latchedEngineState("off", false)).toBe("off")
    expect(latchedEngineState("booting", false)).toBe("booting")
  })

  it("lets a delivered push win over a stale latch (never fights delivery)", () => {
    // A real `off`/`booting`/`stopping` push overrides the optimistic latch.
    expect(latchedEngineState("off", true)).toBe("off")
    expect(latchedEngineState("booting", true)).toBe("booting")
    expect(latchedEngineState("stopping", true)).toBe("stopping")
  })
})
