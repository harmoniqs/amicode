// engine-toggle-utils.test.ts — #1598: unit tests for the engine toggle logic.
import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test"
import {
  parseEngineStateMessage,
  parseFleetRoleMessage,
  sendEngineCommand,
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
})
