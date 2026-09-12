import { describe, expect, test } from "bun:test"
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
