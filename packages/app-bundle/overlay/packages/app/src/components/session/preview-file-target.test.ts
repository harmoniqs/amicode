import { describe, expect, test } from "bun:test"
import { previewFilePathForSession } from "./preview-file-target"

// #1648: `preview-file` reaches every live session view in the app webview, so
// the message carries its target `sessionID` and every non-matching listener
// must ignore it. An absent `sessionID` is the untargeted legacy broadcast.
const msg = (extra: Record<string, unknown> = {}) => ({ source: "amicode", kind: "preview-file", path: "/p/a.md", ...extra })

describe("previewFilePathForSession", () => {
  test("a message targeted at this session opens", () => {
    expect(previewFilePathForSession(msg({ sessionID: "ses_a" }), "ses_a")).toBe("/p/a.md")
  })

  test("a message targeted at ANOTHER session is ignored (the cross-session bleed)", () => {
    expect(previewFilePathForSession(msg({ sessionID: "ses_b" }), "ses_a")).toBeUndefined()
  })

  test("a session-targeted message never opens on a draft page", () => {
    expect(previewFilePathForSession(msg({ sessionID: "ses_a" }), undefined)).toBeUndefined()
  })

  test("an untargeted (legacy / host-unknown) broadcast still opens everywhere", () => {
    expect(previewFilePathForSession(msg(), "ses_a")).toBe("/p/a.md")
    expect(previewFilePathForSession(msg(), undefined)).toBe("/p/a.md")
  })

  test("non-preview, foreign-source, pathless, or malformed messages never open", () => {
    expect(previewFilePathForSession({ ...msg(), kind: "theme" }, "ses_a")).toBeUndefined()
    expect(previewFilePathForSession({ ...msg(), source: "other" }, "ses_a")).toBeUndefined()
    expect(previewFilePathForSession({ source: "amicode", kind: "preview-file" }, "ses_a")).toBeUndefined()
    expect(previewFilePathForSession(msg({ sessionID: 7 }), "ses_a")).toBeUndefined()
    expect(previewFilePathForSession(msg({ sessionID: null }), "ses_a")).toBeUndefined()
    expect(previewFilePathForSession(undefined, "ses_a")).toBeUndefined()
    expect(previewFilePathForSession("preview-file", "ses_a")).toBeUndefined()
  })
})
