import { describe, expect, spyOn, test } from "bun:test"
import { createBugDockController, findBugFiledUrl, findLiveBugSession, matchBugFiledUrl } from "./bug-dock-controller"

// amicode/opencode#117: the bug-report dock's controller — a module-singleton
// state machine the dock component renders against. Plain-module seams (like
// #116's report-bug.ts) because the app has no component-render test surface
// (Solid needs its compile-time transform; see the issue's Testing Decisions).
//
// Bridge contract (the extension slice, amicode#250, mirrors these shapes):
//   DOWN {source:"amicode", kind:"open-bug-report",  sessionID}
//   DOWN {source:"amicode", kind:"close-bug-report", sessionID}
//   UP   {source:"amicode", kind:"bug-filed",         sessionID, url}
//   UP   {source:"amicode", kind:"bug-report-closed", sessionID}

const openMessage = (sessionID: string) => ({ source: "amicode", kind: "open-bug-report", sessionID })

function setup(opts?: { enabled?: () => boolean }) {
  const posts: { kind: string; payload: Record<string, unknown> }[] = []
  const dockCalls: string[] = []
  const controller = createBugDockController({
    enabled: opts?.enabled ?? (() => true),
    post: (kind, payload) => posts.push({ kind, payload }),
    dock: {
      open: () => dockCalls.push("open"),
      close: () => dockCalls.push("close"),
    },
  })
  return { controller, posts, dockCalls }
}

describe("bug-dock controller: open-bug-report (AC1)", () => {
  test("a valid open-bug-report opens the dock on the given session, expanded", () => {
    const { controller, dockCalls } = setup()
    expect(controller.phase()).toBe("closed")

    controller.handleBridgeMessage(openMessage("ses_bug1"))

    expect(controller.phase()).toBe("chat")
    expect(controller.sessionID()).toBe("ses_bug1")
    expect(controller.collapsed()).toBe(false)
    // The dock drives the #116 seam's open() — the button side reads isOpen().
    expect(dockCalls).toEqual(["open"])
  })

})

describe("bug-dock controller: collapse keeps the session alive (AC2)", () => {
  test("the chevron collapses and re-expands, posting nothing and never closing", () => {
    const { controller, posts, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    posts.length = 0
    dockCalls.length = 0

    controller.toggleCollapsed()
    expect(controller.collapsed()).toBe(true)
    expect(controller.phase()).toBe("chat")

    controller.toggleCollapsed()
    expect(controller.collapsed()).toBe(false)

    // Collapse is not close: zero bridge traffic, the dock seam stays open.
    expect(posts).toEqual([])
    expect(dockCalls).toEqual([])
  })

  test("reveal() re-expands an open-but-collapsed dock without posting (the button's revealNonce path)", () => {
    const { controller, posts } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    controller.toggleCollapsed()
    expect(controller.collapsed()).toBe(true)

    controller.reveal()

    expect(controller.collapsed()).toBe(false)
    expect(controller.phase()).toBe("chat")
    expect(posts).toEqual([])
  })

  test("collapse/reveal on a closed dock are no-ops", () => {
    const { controller, posts, dockCalls } = setup()
    controller.toggleCollapsed()
    controller.reveal()
    expect(controller.phase()).toBe("closed")
    expect(controller.collapsed()).toBe(false)
    expect(posts).toEqual([])
    expect(dockCalls).toEqual([])
  })
})

describe("bug-dock controller: close ends the session (AC3)", () => {
  test("the close control posts exactly one bug-report-closed {sessionID} and dismisses", () => {
    const { controller, posts, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    posts.length = 0
    dockCalls.length = 0

    controller.requestClose()

    expect(posts).toEqual([{ kind: "bug-report-closed", payload: { sessionID: "ses_bug1" } }])
    expect(controller.phase()).toBe("closed")
    expect(controller.sessionID()).toBeUndefined()
    expect(dockCalls).toEqual(["close"])

    // exactly once — a second request is a no-op on an already-closed dock
    controller.requestClose()
    expect(posts).toHaveLength(1)
    expect(dockCalls).toEqual(["close"])
  })

  test("collapse-then-close still posts exactly once — collapse posted nothing", () => {
    const { controller, posts } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    controller.toggleCollapsed()
    controller.toggleCollapsed()
    expect(posts).toEqual([])

    controller.requestClose()
    expect(posts).toEqual([{ kind: "bug-report-closed", payload: { sessionID: "ses_bug1" } }])
  })

  test("the real default post builds the bridge envelope {source, kind, sessionID}", () => {
    const spy = spyOn(window.parent, "postMessage").mockImplementation(() => {})
    try {
      const controller = createBugDockController({
        enabled: () => true,
        dock: { open: () => {}, close: () => {} },
      })
      controller.handleBridgeMessage(openMessage("ses_bug1"))
      controller.requestClose()
      expect(spy).toHaveBeenCalledTimes(1)
      const [message, targetOrigin] = spy.mock.calls[0] as unknown as [unknown, unknown]
      expect(message).toEqual({ source: "amicode", kind: "bug-report-closed", sessionID: "ses_bug1" })
      expect(targetOrigin).toBe("*")
    } finally {
      spy.mockRestore()
    }
  })

  test("an extension-initiated close-bug-report for the hosted session closes silently", () => {
    const { controller, posts, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    posts.length = 0
    dockCalls.length = 0

    controller.handleBridgeMessage({ source: "amicode", kind: "close-bug-report", sessionID: "ses_bug1" })

    // The extension owns this close (post-archive) — the dock posts nothing back.
    expect(controller.phase()).toBe("closed")
    expect(posts).toEqual([])
    expect(dockCalls).toEqual(["close"])
  })

  test("close-bug-report for another session — or with no dock open — is ignored", () => {
    const { controller, posts, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    posts.length = 0

    controller.handleBridgeMessage({ source: "amicode", kind: "close-bug-report", sessionID: "ses_other" })
    expect(controller.phase()).toBe("chat")
    expect(posts).toEqual([])

    controller.requestClose()
    posts.length = 0
    dockCalls.length = 0
    controller.handleBridgeMessage({ source: "amicode", kind: "close-bug-report", sessionID: "ses_bug1" })
    expect(posts).toEqual([])
    expect(dockCalls).toEqual([])
  })
})

describe("bug-dock sentinel matching (AC4)", () => {
  test("filed: a line-anchored AMICODE_BUG_FILED <url> yields the url", () => {
    expect(matchBugFiledUrl("AMICODE_BUG_FILED https://github.com/harmoniqs/amicode/issues/123")).toBe(
      "https://github.com/harmoniqs/amicode/issues/123",
    )
  })

  test("filed-via-browser: the no-URL filing path carries the literal token", () => {
    expect(matchBugFiledUrl("AMICODE_BUG_FILED filed-via-browser")).toBe("filed-via-browser")
  })

  test("the sentinel matches inside a longer streamed part — anchored to line start", () => {
    const text = [
      "Diagnostics attached; filing now.",
      "AMICODE_BUG_FILED https://github.com/harmoniqs/amicode/issues/123",
      "Done — the issue is live.",
    ].join("\n")
    expect(matchBugFiledUrl(text)).toBe("https://github.com/harmoniqs/amicode/issues/123")
  })

  test("match: the sentinel mid-line still matches (idle guard handles false positives)", () => {
    expect(matchBugFiledUrl("the line AMICODE_BUG_FILED https://x is what I will print")).toBe("https://x")
  })

  test("no match: a confirm-gate veto prints no sentinel and triggers nothing", () => {
    const veto = "Understood — filing cancelled at the confirm gate. The draft is discarded; nothing was filed."
    expect(matchBugFiledUrl(veto)).toBeUndefined()
  })

  test("no match: bare sentinel without a url, ordinary traffic, empty text", () => {
    expect(matchBugFiledUrl("AMICODE_BUG_FILED")).toBeUndefined()
    expect(matchBugFiledUrl("AMICODE_BUG_FILED\nnext line")).toBeUndefined()
    expect(matchBugFiledUrl("anything else")).toBeUndefined()
    expect(matchBugFiledUrl("")).toBeUndefined()
  })

  test("findBugFiledUrl scans text parts only and returns the first match", () => {
    const parts = [
      { type: "text", text: "working on it…" },
      { type: "tool", text: undefined },
      { type: "text", text: "AMICODE_BUG_FILED https://github.com/harmoniqs/amicode/issues/9" },
      { type: "text", text: "AMICODE_BUG_FILED https://github.com/harmoniqs/amicode/issues/10" },
    ]
    expect(findBugFiledUrl(parts)).toBe("https://github.com/harmoniqs/amicode/issues/9")
    expect(findBugFiledUrl([{ type: "tool" }, { type: "text", text: "no sentinel here" }])).toBeUndefined()
  })
})

describe("bug-dock controller: filing (AC4)", () => {
  test("a sentinel match posts exactly one bug-filed {sessionID, url} and latches the end-state", () => {
    const { controller, posts, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    posts.length = 0
    dockCalls.length = 0

    controller.file("https://github.com/harmoniqs/amicode/issues/123")

    expect(posts).toEqual([
      { kind: "bug-filed", payload: { sessionID: "ses_bug1", url: "https://github.com/harmoniqs/amicode/issues/123" } },
    ])
    expect(controller.phase()).toBe("filed")
    expect(controller.filedUrl()).toBe("https://github.com/harmoniqs/amicode/issues/123")
    // The dock STAYS open in its terminal end-state; the extension owns the
    // real close after archiving.
    expect(dockCalls).toEqual([])

    // exactly once — the watcher keeps seeing the sentinel in the stream
    controller.file("https://github.com/harmoniqs/amicode/issues/123")
    expect(posts).toHaveLength(1)
  })

  test("file() on a closed dock is a no-op", () => {
    const { controller, posts } = setup()
    controller.file("https://github.com/harmoniqs/amicode/issues/123")
    expect(posts).toEqual([])
    expect(controller.phase()).toBe("closed")
  })

  test("filed, then the extension's close-bug-report is ignored (end-state stays until user closes)", () => {
    const { controller, posts, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    controller.file("filed-via-browser")
    posts.length = 0
    dockCalls.length = 0

    controller.handleBridgeMessage({ source: "amicode", kind: "close-bug-report", sessionID: "ses_bug1" })

    expect(controller.phase()).toBe("filed")
    expect(posts).toEqual([])
    expect(dockCalls).toEqual([])
  })

  test("the close control still works from the end-state — one bug-report-closed", () => {
    const { controller, posts } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    controller.file("https://github.com/harmoniqs/amicode/issues/123")
    posts.length = 0

    controller.requestClose()

    expect(posts).toEqual([{ kind: "bug-report-closed", payload: { sessionID: "ses_bug1" } }])
    expect(controller.phase()).toBe("closed")
  })
})

describe("bug-dock controller: gate + open idempotency (AC5)", () => {
  test("the boot param off → open-bug-report is inert (the dock never renders)", () => {
    const { controller, posts, dockCalls } = setup({ enabled: () => false })
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    expect(controller.phase()).toBe("closed")
    expect(controller.sessionID()).toBeUndefined()
    expect(posts).toEqual([])
    expect(dockCalls).toEqual([])
  })

  test("a duplicate open-bug-report for the hosted session is a reveal — no re-adopt, no reset", () => {
    const { controller, posts, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    controller.toggleCollapsed()
    expect(controller.collapsed()).toBe(true)
    dockCalls.length = 0

    controller.handleBridgeMessage(openMessage("ses_bug1"))

    // re-expanded, same session, the dock seam untouched (still exactly one dock)
    expect(controller.collapsed()).toBe(false)
    expect(controller.sessionID()).toBe("ses_bug1")
    expect(dockCalls).toEqual([])
    expect(posts).toEqual([])
  })

  test("a duplicate open does NOT reset the filed end-state", () => {
    const { controller, posts, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    controller.file("https://github.com/harmoniqs/amicode/issues/123")
    posts.length = 0
    dockCalls.length = 0

    controller.handleBridgeMessage(openMessage("ses_bug1"))

    expect(controller.phase()).toBe("filed")
    expect(controller.filedUrl()).toBe("https://github.com/harmoniqs/amicode/issues/123")
    expect(posts).toEqual([])
    expect(dockCalls).toEqual([])
  })

  test("an open-bug-report for a DIFFERENT session while open is ignored — one dock per window", () => {
    const { controller, posts, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    dockCalls.length = 0

    controller.handleBridgeMessage(openMessage("ses_bug2"))

    expect(controller.sessionID()).toBe("ses_bug1")
    expect(controller.phase()).toBe("chat")
    expect(dockCalls).toEqual([])
    expect(posts).toEqual([])
  })

  test("unknown and malformed down-messages are ignored", () => {
    const { controller, posts, dockCalls } = setup()
    const ignored: unknown[] = [
      undefined,
      null,
      "open-bug-report",
      { kind: "open-bug-report", sessionID: "ses_bug1" }, // wrong/missing source
      { source: "amicode", kind: "open-bug-report" }, // no sessionID
      { source: "amicode", kind: "open-bug-report", sessionID: "" }, // empty
      { source: "amicode", kind: "open-bug-report", sessionID: 42 }, // non-string
      { source: "amicode", kind: "theme", colorScheme: "dark" }, // a different lane entirely
      { source: "amicode", kind: "open-compute-connect" },
    ]
    for (const message of ignored) controller.handleBridgeMessage(message)

    expect(controller.phase()).toBe("closed")
    expect(posts).toEqual([])
    expect(dockCalls).toEqual([])
  })

  test("after a full close, a new open-bug-report starts a fresh dock", () => {
    const { controller, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    controller.file("https://github.com/harmoniqs/amicode/issues/123")
    controller.requestClose()
    expect(controller.phase()).toBe("closed")

    controller.handleBridgeMessage(openMessage("ses_bug2"))

    expect(controller.phase()).toBe("chat")
    expect(controller.sessionID()).toBe("ses_bug2")
    expect(controller.filedUrl()).toBeUndefined()
    expect(controller.collapsed()).toBe(false)
    expect(dockCalls).toEqual(["open", "close", "open"])
  })
})

describe("the dismissed guard — a closed dock never resurrects its session (amicode#249 QA)", () => {
  test("after requestClose, the same session id is dropped; a NEW session adopts", () => {
    const { controller, dockCalls } = setup()
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    expect(controller.phase()).toBe("chat")

    controller.requestClose()
    expect(controller.phase()).toBe("closed")

    // The watch's adopt path (and the bridge's) must not bring ses_bug1 back.
    controller.handleBridgeMessage(openMessage("ses_bug1"))
    expect(controller.phase()).toBe("closed")

    controller.handleBridgeMessage(openMessage("ses_bug2"))
    expect(controller.phase()).toBe("chat")
    expect(controller.sessionID()).toBe("ses_bug2")
    expect(dockCalls).toEqual(["open", "close", "open"])
  })
})

