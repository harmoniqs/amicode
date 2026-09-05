// Issue #817 — D1 client-side (spec spec-20260905-045114-session-device-
// lifecycle, revised placement): every session home is first-class WITHOUT
// server project rows, backfill, or a junk lint. Project grouping is resolved
// CLIENT-side over directory/projectID from the session list the global
// home index already returns; a non-git home — pre-existing or new — becomes
// its own group. The founding incident's shape (687 sessions in a non-git
// home, API-visible but panel-invisible) dies here.
import { describe, expect, test } from "vitest"
import {
  buildHomeSessionRecords,
  resolveSessionProject,
} from "../../app-bundle/overlay/packages/app/src/pages/home/home-session-groups"
import type { LocalProject } from "../../app-bundle/overlay/packages/app/src/context/layout"

const session = (id: string, directory: string, projectID = "p-git", updated = 100) => ({
  id,
  directory,
  projectID,
  slug: id,
  version: "test",
  title: `Session ${id}`,
  parentID: undefined,
  time: { created: updated, updated },
})

const gitProject = (id: string, worktree: string): LocalProject =>
  ({ id, worktree, expanded: true }) as LocalProject

describe("resolveSessionProject (D1: every session home is first-class, client-side)", () => {
  test("a session in an opened git project resolves to that project", () => {
    const project = gitProject("p1", "/repo")
    const resolved = resolveSessionProject(session("s1", "/repo"), [project])
    expect(resolved?.project.id).toBe("p1")
    expect(resolved?.projectName).toBe("repo")
  })

  test("a non-git home with NO project row becomes its own first-class group", () => {
    // ~/armonia never opened as a git repo — the founding incident's home.
    const resolved = resolveSessionProject(session("s1", "/home/aaron/armonia"), [])
    expect(resolved).not.toBeNull()
    expect(resolved!.project.worktree).toBe("/home/aaron/armonia")
    expect(resolved!.project.id).toBeUndefined()
    expect(resolved!.projectName).toBe("armonia")
  })

  test("resolution is keyed on the path: projectID match alone is not trusted over the worktree", () => {
    // A stale projectID pointing at another project must not steal the session.
    const other = gitProject("p-other", "/elsewhere")
    const resolved = resolveSessionProject(session("s1", "/repo", "p-other"), [other])
    expect(resolved!.project.worktree).toBe("/repo")
  })

  test("path keys are normalized (trailing slash, windows separators)", () => {
    const project = gitProject("p1", "/repo")
    expect(resolveSessionProject(session("s1", "/repo/"), [project])!.project.id).toBe("p1")
    expect(resolveSessionProject(session("s1", "C:\\repo"), [gitProject("p1", "C:/repo")])!.project.id).toBe("p1")
  })

  test("re-keying: once a non-git home becomes a git repo, the git-derived row supersedes the synthesized group", () => {
    // Before: no project row — synthesized.
    expect(resolveSessionProject(session("s1", "/repo"), [])!.project.id).toBeUndefined()
    // After git-init: the opened project resolves and its identity wins.
    const project = gitProject("p-git", "/repo")
    expect(resolveSessionProject(session("s1", "/repo"), [project])!.project.id).toBe("p-git")
  })
})

describe("buildHomeSessionRecords (D1: the all-projects home never drops a home)", () => {
  const projects = [gitProject("p1", "/repo")]

  test("a non-git home's sessions render as their own group in the all-projects scope", () => {
    const records = buildHomeSessionRecords({
      sessions: [session("s1", "/home/aaron/armonia", "p-stranded")],
      projectDirectories: ["/repo"],
      projects,
      scopeAll: true,
    })
    expect(records).toHaveLength(1)
    expect(records[0]!.project.worktree).toBe("/home/aaron/armonia")
    expect(records[0]!.projectName).toBe("armonia")
  })

  test("a pre-existing non-git home is visible too — no backfill, no server rows", () => {
    const records = buildHomeSessionRecords({
      sessions: [
        session("s1", "/home/aaron/armonia", "p-stranded", 50),
        session("s2", "/repo", "p1", 100),
      ],
      projectDirectories: ["/repo"],
      projects,
      scopeAll: true,
    })
    expect(records.map((r) => r.session.id)).toEqual(["s2", "s1"])
    expect(records[1]!.projectName).toBe("armonia")
  })

  test("the per-project scope still filters to the selected project's directories", () => {
    const records = buildHomeSessionRecords({
      sessions: [session("s1", "/home/aaron/armonia"), session("s2", "/repo")],
      projectDirectories: ["/repo"],
      projects,
      scopeAll: false,
    })
    expect(records.map((r) => r.session.id)).toEqual(["s2"])
  })

  test("records are deduplicated by session id and sorted most-recent first", () => {
    const records = buildHomeSessionRecords({
      sessions: [session("s1", "/repo", "p1", 100), session("s1", "/repo", "p1", 100), session("s2", "/repo", "p1", 200)],
      projectDirectories: ["/repo"],
      projects,
      scopeAll: true,
    })
    expect(records.map((r) => r.session.id)).toEqual(["s2", "s1"])
  })
})
