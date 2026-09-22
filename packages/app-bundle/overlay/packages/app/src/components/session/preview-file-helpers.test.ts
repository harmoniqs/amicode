import { test, expect, describe } from "bun:test"
import { toAbsolutePath, shouldApplyWatcherRead } from "./preview-file-helpers"

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
