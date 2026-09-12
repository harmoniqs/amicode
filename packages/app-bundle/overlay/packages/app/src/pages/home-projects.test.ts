import { describe, expect, test } from "bun:test"
import {
  classifyCreateError,
  gitInitNeedsNotice,
  groupSessionsByProject,
  hiddenCwdWorktree,
  isUnder,
  parseAmicodeProjects,
  projectNameToSlug,
  reconcileProjectList,
  resolveCreationTarget,
  sameProjectList,
} from "./home-projects"

describe("projectNameToSlug", () => {
  test("lowercases, hyphenates whitespace/underscores, strips junk, trims", () => {
    expect(projectNameToSlug("My CZ Gate")).toBe("my-cz-gate")
    expect(projectNameToSlug("  Rydberg__MIS  ")).toBe("rydberg-mis")
    expect(projectNameToSlug("Bell (state) #2!")).toBe("bell-state-2")
    expect(projectNameToSlug("a---b")).toBe("a-b")
  })
  test("names that slugify to nothing return empty", () => {
    expect(projectNameToSlug("")).toBe("")
    expect(projectNameToSlug("   ")).toBe("")
    expect(projectNameToSlug("!!!")).toBe("")
  })
})

describe("resolveCreationTarget", () => {
  test("joins parent + slug, handling a trailing slash", () => {
    expect(resolveCreationTarget({ name: "My Gate", parentDir: "/home/kate/proj" })).toEqual({
      ok: true,
      slug: "my-gate",
      path: "/home/kate/proj/my-gate",
    })
    const trailing = resolveCreationTarget({ name: "My Gate", parentDir: "/home/kate/proj/" })
    expect(trailing.ok && trailing.path).toBe("/home/kate/proj/my-gate")
  })
  test("rejects a name that slugifies to nothing", () => {
    expect(resolveCreationTarget({ name: "  ", parentDir: "/x" })).toEqual({ ok: false, reason: "empty-name" })
  })
})

describe("classifyCreateError", () => {
  test("maps errno codes to inline error kinds", () => {
    expect(classifyCreateError({ code: "EEXIST" })).toBe("collision")
    expect(classifyCreateError({ code: "EACCES" })).toBe("unwritable")
    expect(classifyCreateError({ code: "EROFS" })).toBe("unwritable")
    expect(classifyCreateError({ code: "ENOENT" })).toBe("unwritable")
    expect(classifyCreateError({ code: "EIO" })).toBe("other")
    expect(classifyCreateError(undefined)).toBe("other")
  })
  test("falls back to message text when no code", () => {
    expect(classifyCreateError({ message: "file already exists" })).toBe("collision")
    expect(classifyCreateError({ message: "permission denied" })).toBe("unwritable")
    expect(classifyCreateError({ message: "kaboom" })).toBe("other")
  })
})

describe("gitInitNeedsNotice", () => {
  test("notice iff git init did not succeed", () => {
    expect(gitInitNeedsNotice({ ok: true })).toBe(false)
    expect(gitInitNeedsNotice({ ok: false })).toBe(true)
  })
})

describe("groupSessionsByProject", () => {
  const P = (worktree: string, name = worktree) => ({ worktree, name })
  const S = (id: string, directory: string) => ({ id, directory })
  const opts = (projects: ReturnType<typeof P>[], sessions: ReturnType<typeof S>[]) => ({
    projects,
    sessions,
    projectOf: (s: ReturnType<typeof S>) => projects.find((p) => p.worktree === s.directory),
    directoryOf: (s: ReturnType<typeof S>) => s.directory,
  })

  test("nests sessions under their project, preserving orders; empty projects still appear", () => {
    const a = P("/a")
    const b = P("/b")
    const { projectGroups, orphans } = groupSessionsByProject(
      opts([a, b], [S("s1", "/a"), S("s2", "/b"), S("s3", "/a")]),
    )
    expect(projectGroups.map((g) => g.project.worktree)).toEqual(["/a", "/b"])
    expect(projectGroups[0].sessions.map((s) => s.id)).toEqual(["s1", "s3"])
    expect(projectGroups[1].sessions.map((s) => s.id)).toEqual(["s2"])
    expect(orphans).toEqual([])
  })

  test("sessions with no registered project become orphans grouped by directory (never dropped)", () => {
    const a = P("/a")
    const { projectGroups, orphans } = groupSessionsByProject(
      opts([a], [S("s1", "/a"), S("ghost1", "/tmp/x"), S("ghost2", "/tmp/x"), S("ghost3", "/tmp/y")]),
    )
    expect(projectGroups[0].sessions.map((s) => s.id)).toEqual(["s1"])
    expect(orphans.map((o) => o.directory)).toEqual(["/tmp/x", "/tmp/y"])
    expect(orphans[0].sessions.map((s) => s.id)).toEqual(["ghost1", "ghost2"])
    // every session is reachable: nothing silently dropped
    const reachable = projectGroups.flatMap((g) => g.sessions).length + orphans.flatMap((o) => o.sessions).length
    expect(reachable).toBe(4)
  })

  test("a project with no sessions appears with an empty list", () => {
    const { projectGroups, orphans } = groupSessionsByProject(opts([P("/lonely")], []))
    expect(projectGroups).toHaveLength(1)
    expect(projectGroups[0].sessions).toEqual([])
    expect(orphans).toEqual([])
  })
})

describe("parseAmicodeProjects", () => {
  test("parses a well-formed body and drops malformed entries", () => {
    expect(
      parseAmicodeProjects({
        ok: true,
        parentDir: "/home/kate/AmicodeProjects",
        projects: [
          { slug: "kate-test", path: "/home/kate/AmicodeProjects/kate-test" },
          { slug: 123, path: "/x" }, // bad slug type → dropped
          null, // not an object → dropped
          { slug: "kate-test-2", path: "/home/kate/AmicodeProjects/kate-test-2" },
        ],
      }),
    ).toEqual({
      ok: true,
      parentDir: "/home/kate/AmicodeProjects",
      projects: [
        { slug: "kate-test", path: "/home/kate/AmicodeProjects/kate-test" },
        { slug: "kate-test-2", path: "/home/kate/AmicodeProjects/kate-test-2" },
      ],
    })
  })
  test("unexpected shapes are not-ok (caller then skips reconcile)", () => {
    expect(parseAmicodeProjects(undefined)).toEqual({ ok: false })
    expect(parseAmicodeProjects("nope")).toEqual({ ok: false })
    expect(parseAmicodeProjects({ ok: false })).toEqual({ ok: false })
    expect(parseAmicodeProjects({ ok: true, parentDir: "/p" })).toEqual({ ok: false })
  })
})

describe("isUnder", () => {
  test("matches the parent itself and nested paths, on segment boundaries", () => {
    expect(isUnder("/home/kate/AmicodeProjects", "/home/kate/AmicodeProjects")).toBe(true)
    expect(isUnder("/home/kate/AmicodeProjects/kate-test", "/home/kate/AmicodeProjects")).toBe(true)
    expect(isUnder("/home/kate/AmicodeProjects/kate-test", "/home/kate/AmicodeProjects/")).toBe(true)
    // sibling that shares a prefix but not a segment boundary is NOT under
    expect(isUnder("/home/kate/AmicodeProjects-old/x", "/home/kate/AmicodeProjects")).toBe(false)
    expect(isUnder("/somewhere/else/opencode", "/home/kate/AmicodeProjects")).toBe(false)
    expect(isUnder("/x", "")).toBe(false)
  })
})

describe("reconcileProjectList (additive — surfaces on-disk folders, never removes)", () => {
  const PARENT = "/home/kate/AmicodeProjects"
  const dir = (slug: string) => `${PARENT}/${slug}`

  test("surfaces every on-disk folder even when nothing was tracked (the invisible-folder fix)", () => {
    const next = reconcileProjectList({
      tracked: [],
      amicodeDirs: [dir("kate-test"), dir("kate-test-2"), dir("kate-test-3")],
    })
    expect(next).toEqual([
      { worktree: dir("kate-test"), expanded: false },
      { worktree: dir("kate-test-2"), expanded: false },
      { worktree: dir("kate-test-3"), expanded: false },
    ])
  })

  test("preserves order + expanded of tracked projects and appends only new folders after them", () => {
    const next = reconcileProjectList({
      tracked: [
        { worktree: dir("kate-test-3"), expanded: true },
        { worktree: dir("kate-test"), expanded: false },
      ],
      amicodeDirs: [dir("kate-test"), dir("kate-test-2"), dir("kate-test-3")],
    })
    expect(next).toEqual([
      { worktree: dir("kate-test-3"), expanded: true }, // kept, expanded preserved
      { worktree: dir("kate-test"), expanded: false }, // kept
      { worktree: dir("kate-test-2"), expanded: false }, // newly surfaced, appended
    ])
  })

  test("never removes a tracked entry — a standalone cwd / external open is left intact", () => {
    // Hiding the server cwd or the extension scaffold from the SWITCHER is a
    // display concern (visibleProjects); the store keeps them so their sessions
    // stay reachable in Recent.
    const CWD = "/Users/kate/dev/opencode"
    const EXTERNAL = "/Users/kate/dev/some-repo"
    const next = reconcileProjectList({
      tracked: [
        { worktree: CWD, expanded: true },
        { worktree: EXTERNAL, expanded: false },
        { worktree: dir("kate-test"), expanded: false },
      ],
      amicodeDirs: [dir("kate-test")],
    })
    expect(next.map((p) => p.worktree)).toEqual([CWD, EXTERNAL, dir("kate-test")])
  })

  test("is idempotent at the fixpoint (re-running does not churn)", () => {
    const input = {
      tracked: [
        { worktree: dir("kate-test"), expanded: false },
        { worktree: dir("kate-test-2"), expanded: false },
      ],
      amicodeDirs: [dir("kate-test"), dir("kate-test-2")],
    }
    const once = reconcileProjectList(input)
    const twice = reconcileProjectList({ ...input, tracked: once })
    expect(sameProjectList(once, twice)).toBe(true)
  })
})

describe("hiddenCwdWorktree", () => {
  const PARENT = "/home/kate/AmicodeProjects"

  test("hides the server cwd when it's outside AmicodeProjects and real folders exist (the opencode repo)", () => {
    expect(
      hiddenCwdWorktree({ cwd: "/Users/kate/dev/opencode", amicodeParent: PARENT, amicodeProjectCount: 3 }),
    ).toBe("/Users/kate/dev/opencode")
  })
  test("keeps a cwd that IS an AmicodeProjects folder — a project genuinely named 'opencode' still shows", () => {
    expect(
      hiddenCwdWorktree({ cwd: `${PARENT}/opencode`, amicodeParent: PARENT, amicodeProjectCount: 3 }),
    ).toBeUndefined()
  })
  test("keeps the cwd on a bare machine (no AmicodeProjects folders yet) so the new-session fallback works", () => {
    expect(
      hiddenCwdWorktree({ cwd: "/Users/kate/dev/opencode", amicodeParent: PARENT, amicodeProjectCount: 0 }),
    ).toBeUndefined()
  })
  test("undefined when cwd or parent is unknown (nothing to hide yet)", () => {
    expect(hiddenCwdWorktree({ cwd: undefined, amicodeParent: PARENT, amicodeProjectCount: 3 })).toBeUndefined()
    expect(hiddenCwdWorktree({ cwd: "/x", amicodeParent: undefined, amicodeProjectCount: 3 })).toBeUndefined()
  })
})

describe("sameProjectList", () => {
  test("compares worktree + expanded in order", () => {
    const a = [{ worktree: "/a", expanded: true }, { worktree: "/b", expanded: false }]
    expect(sameProjectList(a, [{ worktree: "/a", expanded: true }, { worktree: "/b", expanded: false }])).toBe(true)
    expect(sameProjectList(a, [{ worktree: "/a", expanded: false }, { worktree: "/b", expanded: false }])).toBe(false)
    expect(sameProjectList(a, [{ worktree: "/b", expanded: false }, { worktree: "/a", expanded: true }])).toBe(false)
    expect(sameProjectList(a, [{ worktree: "/a", expanded: true }])).toBe(false)
  })
})
