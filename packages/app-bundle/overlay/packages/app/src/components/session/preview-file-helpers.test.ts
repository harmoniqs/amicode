import { test, expect, describe } from "bun:test"
import {
  toAbsolutePath,
  shouldApplyWatcherRead,
  previewSizeLimit,
  isPreviewRefreshFor,
  MAX_HTML_PREVIEW_SIZE,
  MAX_TEXT_PREVIEW_SIZE,
} from "./preview-file-helpers"

// #1414 (my review finding): saving a .tex opened by a workspace-RELATIVE path
// posted `run-latex` with that relative path; the compile bridge's containment
// resolver rejects non-absolute paths — silently — so the compile never ran.
// The path must be made absolute against the workspace directory before posting.
describe("toAbsolutePath", () => {
  test("joins a relative path onto the workspace directory", () => {
    expect(toAbsolutePath("paper/main.tex", "/work")).toBe("/work/paper/main.tex")
  })

  test("leaves an already-absolute path untouched", () => {
    expect(toAbsolutePath("/abs/main.tex", "/work")).toBe("/abs/main.tex")
  })

  test("does not double the separator when the directory has a trailing slash", () => {
    expect(toAbsolutePath("main.tex", "/work/")).toBe("/work/main.tex")
  })

  test("resolves against the POSIX root directory without dropping to a relative path", () => {
    // #1414: stripping the trailing separator must not turn "/" into "" — that
    // would make the path relative and the compile bridge would reject it.
    expect(toAbsolutePath("main.tex", "/")).toBe("/main.tex")
  })

  test("returns the relative path unchanged when no directory is known", () => {
    expect(toAbsolutePath("main.tex", undefined)).toBe("main.tex")
  })

  test("leaves a Windows drive-letter path untouched (backslash and forward slash)", () => {
    expect(toAbsolutePath("C:\\work\\main.tex", "C:\\work")).toBe("C:\\work\\main.tex")
    expect(toAbsolutePath("C:/work/main.tex", "/w")).toBe("C:/work/main.tex")
  })

  test("leaves a Windows UNC path untouched", () => {
    expect(toAbsolutePath("\\\\server\\share\\main.tex", "/w")).toBe("\\\\server\\share\\main.tex")
  })
})

// #1414 (CodeRabbit, Major·Data integrity): the watcher's async read completion
// applied content with no re-check of the current state, so a read finishing
// after a file switch / newer read / fresh edit clobbered the editor.
describe("shouldApplyWatcherRead", () => {
  const base = {
    capturedPath: "/w/a.tex",
    currentPath: "/w/a.tex",
    capturedGeneration: 3,
    latestGeneration: 3,
    hasUnsavedEdits: false,
  }

  test("applies when path, generation and edit-state still match", () => {
    expect(shouldApplyWatcherRead(base)).toBe(true)
  })

  test("discards when the previewed file switched mid-read", () => {
    expect(shouldApplyWatcherRead({ ...base, currentPath: "/w/b.tex" })).toBe(false)
  })

  test("discards when a newer read superseded this one", () => {
    expect(shouldApplyWatcherRead({ ...base, latestGeneration: 4 })).toBe(false)
  })

  test("discards when the user began editing during the read", () => {
    expect(shouldApplyWatcherRead({ ...base, hasUnsavedEdits: true })).toBe(false)
  })
})

// #2130: the HTML size cap and the agent tool's refresh request.
describe("previewSizeLimit", () => {
  test("HTML pages get the larger cap; everything else read as text keeps 1 MB", () => {
    expect(previewSizeLimit("/r/transport-dashboard.html")).toBe(MAX_HTML_PREVIEW_SIZE)
    expect(previewSizeLimit("page.HTM")).toBe(MAX_HTML_PREVIEW_SIZE)
    expect(previewSizeLimit("/r/notes.md")).toBe(MAX_TEXT_PREVIEW_SIZE)
    expect(previewSizeLimit("/r/data.json")).toBe(MAX_TEXT_PREVIEW_SIZE)
    // a 1.73 MB dashboard with embedded plots now fits
    expect(1_732_245).toBeLessThan(previewSizeLimit("/r/transport-dashboard.html"))
  })
})

describe("isPreviewRefreshFor", () => {
  const msg = (extra: Record<string, unknown> = {}) => ({
    source: "amicode",
    kind: "preview-file",
    path: "/v/dash/index.html",
    refresh: true,
    sessionID: "ses_a",
    ...extra,
  })
  test("a refresh for this file and this session", () => {
    expect(isPreviewRefreshFor(msg(), "/v/dash/index.html", "ses_a")).toBe(true)
  })
  test("absolute message path matches a workspace-relative previewed path", () => {
    expect(isPreviewRefreshFor(msg({ path: "/w/repo/docs/a.md" }), "docs/a.md", "ses_a")).toBe(true)
  })
  test("an unstamped message refreshes every view of the file", () => {
    expect(isPreviewRefreshFor(msg({ sessionID: undefined }), "/v/dash/index.html", "ses_b")).toBe(true)
  })
  test("another session, another file, no refresh flag, or not a preview-file → no", () => {
    expect(isPreviewRefreshFor(msg(), "/v/dash/index.html", "ses_b")).toBe(false)
    expect(isPreviewRefreshFor(msg(), "/v/dash/other.html", "ses_a")).toBe(false)
    expect(isPreviewRefreshFor(msg({ path: "/x/index.html" }), "/v/dash/index.html", "ses_a")).toBe(false)
    expect(isPreviewRefreshFor(msg({ refresh: undefined }), "/v/dash/index.html", "ses_a")).toBe(false)
    expect(isPreviewRefreshFor(msg({ kind: "open-file" }), "/v/dash/index.html", "ses_a")).toBe(false)
    expect(isPreviewRefreshFor("preview-file", "/v/dash/index.html", "ses_a")).toBe(false)
  })
})
