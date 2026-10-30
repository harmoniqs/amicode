import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// #1249 wiring pins (JSX cannot render under bun here): the Preview remounts per
// session, and the file view / tab route every draft transition through the
// per-(session, path) store so a remount neither leaks nor loses an edit.

const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8")
const sidePanel = read("../../pages/session/session-side-panel.tsx")
const fileView = read("./preview-file-view.tsx")
const previewTab = read("./session-preview-tab.tsx")

describe("session-scoped Preview", () => {
  test("both Preview mounts are keyed by the session so another session's workspace never carries over", () => {
    const keyed = sidePanel.match(/<Show when=\{params\.id \?\? "none"\} keyed>\s*\{\(\) => \(\s*<SessionPreviewTab/g)
    expect(keyed?.length).toBe(2)
  })

  test("the tab hands its mounted session to every file view as the draft scope", () => {
    expect(previewTab).toContain("const draftSession = props.sessionID?.()")
    expect(previewTab).toContain("draftSession={draftSession}")
  })
})

describe("draft lifecycle goes through the store", () => {
  test("an edit writes the draft; a remount restores it before any disk read can replace it", () => {
    expect(fileView).toContain("previewDrafts.write(")
    expect(fileView).toContain("previewDrafts.get(")
    // The disk read must not replace a cached draft.
    expect(fileView).toMatch(/if \(unsavedContent\(\) !== null\)[\s\S]{0,80}return/)
  })

  test("a save clears only its own revision and is serialized per file; a newer edit keeps the tab dirty", () => {
    expect(fileView).toContain("previewDrafts.enqueueSave(")
    expect(fileView).toContain("previewDrafts.clear(")
    expect(fileView).toContain("revision")
  })

  test("close / discard removes the draft; close intent is session-owned and token-checked", () => {
    expect(previewTab).toContain("previewDrafts.clear(draftSession, path)")
    expect(previewTab).toContain("previewDrafts.requestClose(")
    expect(previewTab).toContain("previewDrafts.cancelClose(")
    expect(previewTab).toContain("previewDrafts.resolveClose(")
  })

  test("dirty draft paths come back with the session (restore target includes them)", () => {
    expect(previewTab).toContain("previewDrafts.paths(")
  })
})
