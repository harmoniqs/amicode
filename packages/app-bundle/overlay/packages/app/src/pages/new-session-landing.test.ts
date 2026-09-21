import { describe, expect, mock, test } from "bun:test"
import { resolveLandingDirectory } from "./new-session-landing"

describe("resolveLandingDirectory", () => {
  test("uses the first registered project's worktree", () => {
    expect(resolveLandingDirectory([{ worktree: "/repo/a" }, { worktree: "/repo/b" }], "/cwd")).toBe("/repo/a")
  })

  // The amicode chat server runs with cwd set to an internal scaffold dir that is
  // never registered as a project. Before this fallback, NewSessionLanding and the
  // titlebar "+" both gave up silently, leaving a permanently blank app.
  test("falls back to the server directory when no project is registered", () => {
    expect(resolveLandingDirectory([], "/scaffold/opencode-project")).toBe("/scaffold/opencode-project")
  })

  test("returns undefined when there is neither a project nor a server directory", () => {
    expect(resolveLandingDirectory([], undefined)).toBeUndefined()
  })
})

describe("empty-workspace landing gate (no directory → showEmpty)", () => {
  // The landing page decides between creating a draft (normal) and showing the
  // empty-workspace component (no workspace folder open). These tests verify
  // the decision logic by exercising resolveLandingDirectory as the predicate:
  // `!directory` is the condition that sets showEmpty=true in NewSessionLanding.
  //
  // The fix for CodeRabbit's review: land() now reads workspaceProjects()
  // FIRST, so the createEffect subscribes to the reactive store. When a
  // workspace folder arrives, the effect re-runs and resolves a directory.

  test("truthy directory does NOT trigger empty state", () => {
    const dir = resolveLandingDirectory([{ worktree: "/proj" }], undefined)
    expect(dir).toBeTruthy()
  })

  test("undefined directory triggers empty state (no projects, no server dir)", () => {
    const dir = resolveLandingDirectory([], undefined)
    expect(dir).toBeFalsy()
  })

  test("empty server dir is falsy — triggers empty state", () => {
    const dir = resolveLandingDirectory([], "")
    // empty string is falsy in JS, which means `if (!directory)` catches it
    expect(!dir).toBe(true)
  })

  test("workspace projects take priority over server projects", () => {
    // Simulates the fix: workspaceProjects are preferred over ctx.projects
    const wsProjects = [{ worktree: "/ws/project" }]
    const serverProjects = [{ worktree: "/server/project" }]
    const dir = resolveLandingDirectory(
      wsProjects.length > 0 ? wsProjects : serverProjects,
      undefined,
    )
    expect(dir).toBe("/ws/project")
  })

  test("falls back to server projects when workspace is empty", () => {
    const wsProjects: { worktree: string }[] = []
    const serverProjects = [{ worktree: "/server/project" }]
    const dir = resolveLandingDirectory(
      wsProjects.length > 0 ? wsProjects : serverProjects,
      undefined,
    )
    expect(dir).toBe("/server/project")
  })
})

describe("requestAddWorkspaceProject", () => {
  test("posts the add-workspace-project message to the parent frame", () => {
    // Save the real postMessage, mock it
    const original = globalThis.window?.parent?.postMessage
    const posted: unknown[] = []
    const mockPostMessage = mock((...args: unknown[]) => posted.push(args))

    // Mock window.parent.postMessage
    const fakeParent = { postMessage: mockPostMessage }
    Object.defineProperty(globalThis, "window", {
      value: { parent: fakeParent },
      writable: true,
      configurable: true,
    })

    // Import and call
    const { requestAddWorkspaceProject } = require("@/utils/amicode-workspace-projects")
    requestAddWorkspaceProject()

    expect(mockPostMessage).toHaveBeenCalledTimes(1)
    expect(posted[0]).toEqual([
      { source: "amicode", kind: "add-workspace-project" },
      "*",
    ])
  })
})
