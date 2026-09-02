import { describe, expect, test } from "bun:test"
import { resolveReviewDiffs } from "./resolve-review-diffs"
import type { ToolEditPart } from "./accumulate-diffs"

const edit = (file: string, overrides: Partial<ToolEditPart> = {}): ToolEditPart => ({
  file,
  patch: `@@ -1,1 +1,2 @@\n-old\n+new`,
  additions: 1,
  deletions: 1,
  ...overrides,
})

const DIR = "/Users/jj/project"
const HOME = "/Users/jj"

describe("resolveReviewDiffs", () => {
  test("returns empty when server reports no net changes (all edits reverted)", () => {
    // Server says: no net changes. But there ARE tool edit parts in the session.
    // The old code would fall through to accumulateDiffs and show the edits.
    const result = resolveReviewDiffs({
      serverDiffs: [],
      serverReady: true,
      editParts: [edit("src/a.ts"), edit("src/b.ts")],
      directory: DIR,
      home: HOME,
    })

    expect(result).toEqual([])
  })

  test("returns server diffs when server has data", () => {
    const result = resolveReviewDiffs({
      serverDiffs: [
        { file: "src/main.ts", additions: 10, deletions: 2, status: "modified" },
      ],
      serverReady: true,
      editParts: [edit("src/main.ts"), edit("src/other.ts")],
      directory: DIR,
      home: HOME,
    })

    expect(result).toHaveLength(1)
    expect(result[0].file).toBe("~/project/src/main.ts")
    expect(result[0].additions).toBe(10)
  })

  test("uses fallback accumulateDiffs while server query is loading", () => {
    const result = resolveReviewDiffs({
      serverDiffs: [],
      serverReady: false,
      editParts: [edit("src/a.ts", { title: "~/project/src/a.ts", additions: 3, deletions: 1 })],
      directory: DIR,
      home: HOME,
    })

    expect(result).toHaveLength(1)
    expect(result[0].file).toBe("~/project/src/a.ts")
    expect(result[0].additions).toBe(3)
  })

  test("returns empty when loading and no edit parts exist", () => {
    const result = resolveReviewDiffs({
      serverDiffs: [],
      serverReady: false,
      editParts: [],
      directory: DIR,
      home: HOME,
    })

    expect(result).toEqual([])
  })

  test("normalizes relative server paths with ~/project prefix", () => {
    const result = resolveReviewDiffs({
      serverDiffs: [
        { file: "src/foo.ts", additions: 1, deletions: 0, status: "added" },
      ],
      serverReady: true,
      editParts: [],
      directory: DIR,
      home: HOME,
    })

    expect(result[0].file).toBe("~/project/src/foo.ts")
  })

  test("preserves absolute server paths unchanged", () => {
    const result = resolveReviewDiffs({
      serverDiffs: [
        { file: "/other/repo/file.ts", additions: 1, deletions: 0, status: "added" },
      ],
      serverReady: true,
      editParts: [],
      directory: DIR,
      home: HOME,
    })

    expect(result[0].file).toBe("/other/repo/file.ts")
  })

  test("preserves ~/ server paths unchanged", () => {
    const result = resolveReviewDiffs({
      serverDiffs: [
        { file: "~/project/src/bar.ts", additions: 2, deletions: 1, status: "modified" },
      ],
      serverReady: true,
      editParts: [],
      directory: DIR,
      home: HOME,
    })

    expect(result[0].file).toBe("~/project/src/bar.ts")
  })

  test("filters out server diffs without a file field", () => {
    const result = resolveReviewDiffs({
      serverDiffs: [
        { additions: 1, deletions: 0 },
        { file: "src/real.ts", additions: 2, deletions: 1, status: "modified" },
      ],
      serverReady: true,
      editParts: [],
      directory: DIR,
      home: HOME,
    })

    expect(result).toHaveLength(1)
    expect(result[0].file).toBe("~/project/src/real.ts")
  })
})
