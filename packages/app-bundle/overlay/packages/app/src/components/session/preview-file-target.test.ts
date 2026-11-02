import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
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

// #1648 wiring pins (JSX cannot render under bun here): every in-app consumer of
// the `preview-file` bridge message must go through the session predicate, and
// both Preview mounts must tell the tab which session it belongs to — otherwise
// a prewarmed/backgrounded session view would still open (and persist) a file
// that was opened for another session.
describe("preview-file consumers are session-scoped", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8")
  const sessionPage = read("../../pages/session.tsx")
  const draftPage = read("../../pages/new-session.tsx")
  const previewTab = read("./session-preview-tab.tsx")
  const sidePanel = read("../../pages/session/session-side-panel.tsx")

  test("session page, draft page and Preview tab all filter through previewFilePathForSession", () => {
    expect(sessionPage).toContain("previewFilePathForSession(e.data, params.id)")
    expect(draftPage).toContain("previewFilePathForSession(")
    expect(previewTab).toContain("previewFilePathForSession(event.data, props.sessionID?.())")
  })

  test("no consumer re-parses the raw preview-file message itself", () => {
    for (const source of [sessionPage, draftPage, previewTab]) {
      expect(source).not.toMatch(/kind\s*!==\s*"preview-file"/)
    }
  })

  test("both side-panel Preview mounts pass the session id so the tab can ignore other sessions' opens", () => {
    const mounts = sidePanel.match(/<SessionPreviewTab [^\n]*sessionID=\{\(\) => params\.id\}/g)
    expect(mounts?.length).toBe(2)
  })
})
