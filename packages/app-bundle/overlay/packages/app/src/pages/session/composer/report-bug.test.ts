import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { bugDock } from "./bug-dock"
import { REPORT_BUG_COMMAND, reportBug } from "./report-bug"

// amicode#116: the v2 composer's report-a-bug button. Dock absent/closed →
// post the bridge command (the extension host opens the flow); dock open →
// reveal/re-expand it and post nothing. The dock itself is slice #117, built
// against the bugDock seam — these tests drive the signal directly.
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

  test("reveals the open dock instead of posting — reveal/re-expand, zero bridge messages", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    try {
      bugDock.open() // #117 drives this when its dock mounts
      expect(bugDock.isOpen()).toBe(true)
      const before = bugDock.revealNonce()

      reportBug()

      expect(spy).not.toHaveBeenCalled()
      // reveal must be observable even on an already-open dock (re-expand).
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
      expect(spy).not.toHaveBeenCalled()

      bugDock.close()
      expect(bugDock.isOpen()).toBe(false)
      reportBug()
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  test("an injected dock seam is consulted — open dock → reveal called, no post", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    let revealed = 0
    try {
      reportBug({ isOpen: () => true, reveal: () => revealed++ })
      expect(revealed).toBe(1)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
