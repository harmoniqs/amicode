// engine-toggle-utils.test.ts — #1598: unit tests for the engine toggle logic.
import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  parseEngineStateMessage,
  parseFleetRoleMessage,
  sendEngineCommand,
  engineDotClass,
  latchedEngineStateAt,
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

// #1608 follow-up (BUG1): the latch must be SELF-LIMITING. The stuck-stopping
// bug was `stopping` staying locked forever when the confirming `off` push was
// dropped (engine dead → SSE gone → push never delivered). The latch resolves
// to the INTENDED terminal state `off` after a timeout, so the toggle is never
// permanently grayed — a user can always click to restart.
describe("latchedEngineStateAt — self-expiring latch (#1608 BUG1)", () => {
  const TIMEOUT = 4000
  it("reads `stopping` inside the confirm window (instant feedback preserved)", () => {
    // latched at t=0, now=1s, still within the 4s window
    expect(latchedEngineStateAt("on", 0, 1000, TIMEOUT)).toBe("stopping")
  })

  it("falls back to `off` once the window elapses with no confirming push", () => {
    // latched at t=0, now=5s > 4s window → resolve to the intended terminal off
    expect(latchedEngineStateAt("on", 0, 5000, TIMEOUT)).toBe("off")
  })

  it("resolves to `off` exactly at the boundary (>= timeout)", () => {
    expect(latchedEngineStateAt("on", 0, 4000, TIMEOUT)).toBe("off")
  })

  it("passes raw through when there is no latch (latchedAt undefined)", () => {
    expect(latchedEngineStateAt("on", undefined, 9999, TIMEOUT)).toBe("on")
    expect(latchedEngineStateAt("off", undefined, 9999, TIMEOUT)).toBe("off")
  })

  it("lets a delivered push win over the latch, even inside the window", () => {
    // a real off/booting push landed → raw changed → it wins immediately
    expect(latchedEngineStateAt("off", 0, 500, TIMEOUT)).toBe("off")
    expect(latchedEngineStateAt("booting", 0, 500, TIMEOUT)).toBe("booting")
  })
})

// #1608 follow-up (BUG1b — live update lost): the pure helper above was correct,
// but the toggle only settled to `off` when the popover was CLOSED and REOPENED.
// Root cause: effectiveEngineState() reads `now()` (plain Date.now(), NOT
// reactive), so the self-expiry setTimeout's setTick() invalidated nothing —
// the derived state never re-ran at the 4s boundary. The fix wires a `tick`
// signal that effectiveEngineState() READS, so the timer's setTick re-derives
// it live. solid-js is not resolvable in this package's node_modules (engine
// source tree, built by the bun bundler, not pnpm install — see the session
// ledger's honest-degradation note), so a createRoot/createEffect reactivity
// harness cannot run here; the binary build is the authoritative compile gate.
// We guard the exact regression with a source assertion: effectiveEngineState()
// MUST read the tick, or the setTimeout fires into the void again.
describe("engine-state-signal reactivity wiring (#1608 BUG1b)", () => {
  const signalSrc = readFileSync(
    fileURLToPath(new URL("./engine-state-signal.ts", import.meta.url)),
    "utf8",
  )

  it("names the tick reader (does not discard the setter alone)", () => {
    // the bug was `const [, setTick] = createSignal(0)` — a write with no reader
    expect(signalSrc).toContain("const [tick, setTick] = createSignal(0)")
  })

  it("effectiveEngineState reads tick() so the self-expiry timer re-derives", () => {
    const body = signalSrc.slice(
      signalSrc.indexOf("export function effectiveEngineState"),
      signalSrc.indexOf("function clearLatchTimer"),
    )
    expect(body).toContain("tick()")
    expect(body).toContain("latchedEngineStateAt(")
  })

  it("the self-expiry timer bumps tick to invalidate the derived state", () => {
    const body = signalSrc.slice(
      signalSrc.indexOf("export function latchStopRequested"),
      signalSrc.indexOf("export function applyEngineState"),
    )
    expect(body).toContain("setTick(")
  })
})
