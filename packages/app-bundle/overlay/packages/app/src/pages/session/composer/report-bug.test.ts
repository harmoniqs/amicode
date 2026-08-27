import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { bugDock } from "./bug-dock"
import { REPORT_BUG_COMMAND, reportBug } from "./report-bug"

// amicode#116 + #476: the v2 composer's report-a-bug button. Dock absent/closed →
// post the bridge command (the extension host opens the flow); dock open →
// reveal/re-expand AND still post the command so the extension can prompt to
// start a new report (#476 — the second click must not be swallowed).
describe("reportBug", () => {
  afterEach(() => bugDock.close())

  test("posts exactly one amicode.reportBug bridge message when no dock is open", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    try {
      reportBug()
      expect(spy).toHaveBeenCalledTimes(1)
      // Same envelope contract as postAmicode — chat_panel.ts relays only
      // allowlisted commands, so the shape and command string are load-bearing.
      const [message, targetOrigin] = spy.mock.calls[0] as unknown as [unknown, unknown]
      expect(message).toEqual({ source: "amicode", kind: "command", command: REPORT_BUG_COMMAND })
      expect(REPORT_BUG_COMMAND).toBe("amicode.reportBug")
      expect(targetOrigin).toBe("*")
    } finally {
      spy.mockRestore()
    }
  })

  test("reveals the open dock AND posts the command — #476 second click not swallowed", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    try {
      bugDock.open() // #117 drives this when its dock mounts
      expect(bugDock.isOpen()).toBe(true)
      const before = bugDock.revealNonce()

      reportBug()

      // Both: focus the existing dock and let the extension prompt for a new report.
      expect(spy).toHaveBeenCalledTimes(1)
      const [message] = spy.mock.calls[0] as unknown as [Record<string, unknown>, unknown]
      expect(message).toEqual({ source: "amicode", kind: "command", command: REPORT_BUG_COMMAND })
      // reveal must still be observable (re-expand).
      expect(bugDock.revealNonce()).toBe(before + 1)
      expect(bugDock.isOpen()).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test("posts again once the dock has been dismissed", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    try {
      bugDock.open()
      reportBug()
      expect(spy).toHaveBeenCalledTimes(1)

      bugDock.close()
      expect(bugDock.isOpen()).toBe(false)
      reportBug()
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })

  test("an injected dock seam is consulted — open dock → reveal called and command posted (#476)", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    let revealed = 0
    try {
      reportBug({ isOpen: () => true, reveal: () => revealed++ })
      expect(revealed).toBe(1)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  // amicode#277: carry the composer's live model selection onto the bug session
  test("carries the live model selection onto the bridge message (AC1)", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    try {
      reportBug(undefined, { providerID: "openai", modelID: "gpt-4o" })
      const [msg] = spy.mock.calls[0] as unknown as [Record<string, unknown>, unknown]
      expect(msg).toEqual({ source: "amicode", kind: "command", command: REPORT_BUG_COMMAND, model: { providerID: "openai", modelID: "gpt-4o" } })
    } finally {
      spy.mockRestore()
    }
  })

  test("variant travels with the selection (AC2)", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    try {
      reportBug(undefined, { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "thinking" })
      const [msg] = spy.mock.calls[0] as unknown as [Record<string, unknown>, unknown]
      expect(msg).toEqual({
        source: "amicode",
        kind: "command",
        command: REPORT_BUG_COMMAND,
        model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "thinking" },
      })
    } finally {
      spy.mockRestore()
    }
  })

  test("absent model tolerated — no model field (AC3)", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    try {
      reportBug(undefined, undefined)
      const [msg] = spy.mock.calls[0] as unknown as [Record<string, unknown>, unknown]
      expect(msg).toEqual({ source: "amicode", kind: "command", command: REPORT_BUG_COMMAND })
      expect("model" in msg).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  test("malformed, oversized, or absent payload never blocks — stripped (AC4 + AC5)", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    try {
      // malformed: missing modelID
      reportBug(undefined, { providerID: "openai", modelID: "" } as unknown as { providerID: string; modelID: string })
      let [msg] = spy.mock.calls[0] as unknown as [Record<string, unknown>, unknown]
      expect("model" in msg).toBe(false)
      spy.mockClear()
      // oversized
      reportBug(undefined, { providerID: "x".repeat(201), modelID: "gpt-4o" })
      ;[msg] = spy.mock.calls[0] as unknown as [Record<string, unknown>, unknown]
      expect("model" in msg).toBe(false)
      // variant oversized → stripped but model kept
      spy.mockClear()
      reportBug(undefined, { providerID: "openai", modelID: "gpt-4o", variant: "x".repeat(201) })
      ;[msg] = spy.mock.calls[0] as unknown as [Record<string, unknown>, unknown]
      expect(msg).toEqual({ source: "amicode", kind: "command", command: REPORT_BUG_COMMAND, model: { providerID: "openai", modelID: "gpt-4o" } })
    } finally {
      spy.mockRestore()
    }
  })
})
