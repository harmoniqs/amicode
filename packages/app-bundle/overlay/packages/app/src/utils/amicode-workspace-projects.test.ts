import { describe, expect, test, mock } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"
import { notifyProjectSelected } from "./amicode-workspace-projects"

describe("amicode workspace-projects — notifyProjectSelected (#663)", () => {
  test("posts a project-selected envelope to the parent frame", () => {
    const calls: unknown[] = []
    const orig = window.parent.postMessage
    window.parent.postMessage = (...args: unknown[]) => { calls.push(args) }
    try {
      notifyProjectSelected("/Users/jj/harmoniqs")
      expect(calls).toHaveLength(1)
      const [msg, origin] = calls[0] as [Record<string, unknown>, string]
      expect(msg).toEqual({ source: "amicode", kind: "project-selected", path: "/Users/jj/harmoniqs", autoExpand: true })
      expect(origin).toBe("*")
    } finally {
      window.parent.postMessage = orig
    }
  })

  test("explicit selection defaults to autoExpand=true", () => {
    const calls: unknown[] = []
    const orig = window.parent.postMessage
    window.parent.postMessage = (...args: unknown[]) => { calls.push(args) }
    try {
      notifyProjectSelected("/projects/foo")
      const [msg] = calls[0] as [Record<string, unknown>]
      expect(msg.autoExpand).toBe(true)
    } finally {
      window.parent.postMessage = orig
    }
  })

  test("session navigation passes autoExpand=false", () => {
    const calls: unknown[] = []
    const orig = window.parent.postMessage
    window.parent.postMessage = (...args: unknown[]) => { calls.push(args) }
    try {
      notifyProjectSelected("/projects/foo", false)
      const [msg] = calls[0] as [Record<string, unknown>]
      expect(msg.autoExpand).toBe(false)
    } finally {
      window.parent.postMessage = orig
    }
  })
})

describe("prompt-project-selector — no false default (#673)", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "components", "prompt-project-selector.tsx"),
    "utf8",
  )

  test("selected() returns current() without a fallback to available[0]", () => {
    expect(src).not.toMatch(/selected\s*=\s*\(\)\s*=>\s*current\(\)\s*\?\?\s*input/)
  })

  test("trigger shows a placeholder when no project is selected", () => {
    expect(src).toMatch(/Pick a project/i)
  })

  test("no 'No project' section in the dropdown (toggle replaces it)", () => {
    expect(src).not.toMatch(/>None</)
  })

  test("controller select always forwards to controls.select (no skip when same project)", () => {
    const selectFn = src.slice(src.indexOf("const select = (project"))
    const fnEnd = selectFn.indexOf("\n  const add")
    const selectBody = selectFn.slice(0, fnEnd)
    expect(selectBody).toContain("input.controls().select(")
    expect(selectBody).not.toMatch(/pathKey\(project\.worktree\)\s*!==\s*pathKey\(current/)
  })
})

describe("session-composer-controls — toggle deselect (#673)", () => {
  const ctrlSrc = readFileSync(
    resolve(__dirname, "..", "pages", "session", "composer", "session-composer-controls.ts"),
    "utf8",
  )

  test("deselect path notifies the extension to clear the sidebar highlight", () => {
    const selectFn = ctrlSrc.slice(ctrlSrc.indexOf("const selectProject"))
    const toggleBranch = selectFn.slice(0, selectFn.indexOf("notifyProjectSelected(worktree)"))
    expect(toggleBranch).toMatch(/notifyProjectSelected/)
  })

  test("deselect notification passes autoExpand true so the folder collapses", () => {
    const selectFn = ctrlSrc.slice(ctrlSrc.indexOf("const selectProject"))
    // The toggle branch's notifyProjectSelected call (before the main one)
    const toggleBranch = selectFn.slice(0, selectFn.indexOf("notifyProjectSelected(worktree)"))
    // Must NOT pass false — needs true (or default) so the sidebar collapses the old folder
    expect(toggleBranch).not.toMatch(/notifyProjectSelected\([^)]*,\s*false/)
  })
})
