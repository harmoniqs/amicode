import { describe, expect, test } from "bun:test"
import { accumulateDiffs, type ToolEditPart } from "./accumulate-diffs"

const edit = (file: string, overrides: Partial<ToolEditPart> = {}): ToolEditPart => ({
  file,
  patch: `@@ -1,1 +1,2 @@\n-old\n+new\n+line`,
  additions: 1,
  deletions: 1,
  ...overrides,
})

describe("accumulateDiffs", () => {
  test("single-edit file preserves patch unchanged", () => {
    const patch = "@@ -1,3 +1,4 @@\n context\n-removed\n+added\n+extra"
    const result = accumulateDiffs([edit("src/a.ts", { patch, additions: 2, deletions: 1 })])

    expect(result).toHaveLength(1)
    expect(result[0].file).toBe("src/a.ts")
    expect(result[0].patch).toBe(patch)
    expect(result[0].additions).toBe(2)
    expect(result[0].deletions).toBe(1)
  })

  test("multi-edit file keeps last patch and sums additions/deletions", () => {
    const result = accumulateDiffs([
      edit("src/a.ts", { additions: 3, deletions: 1, patch: "patch-1" }),
      edit("src/a.ts", { additions: 2, deletions: 4, patch: "patch-2" }),
      edit("src/a.ts", { additions: 1, deletions: 0, patch: "patch-3" }),
    ])

    expect(result).toHaveLength(1)
    expect(result[0].file).toBe("src/a.ts")
    expect(result[0].patch).toBe("patch-3")
    expect(result[0].additions).toBe(6)
    expect(result[0].deletions).toBe(5)
  })

  test("multi-edit file is marked 'modified' even if first edit was 'added'", () => {
    const result = accumulateDiffs([
      edit("src/new.ts", { additions: 5, deletions: 0 }),
      edit("src/new.ts", { additions: 2, deletions: 1 }),
    ])

    expect(result[0].status).toBe("modified")
  })

  test("single-edit new file is marked 'added'", () => {
    const result = accumulateDiffs([edit("src/new.ts", { additions: 5, deletions: 0 })])
    expect(result[0].status).toBe("added")
  })

  test("multiple different files are each tracked independently", () => {
    const result = accumulateDiffs([
      edit("src/a.ts", { additions: 1, deletions: 0, patch: "patch-a" }),
      edit("src/b.ts", { additions: 2, deletions: 1, patch: "patch-b" }),
    ])

    expect(result).toHaveLength(2)
    expect(result[0].file).toBe("src/a.ts")
    expect(result[0].patch).toBe("patch-a")
    expect(result[1].file).toBe("src/b.ts")
    expect(result[1].patch).toBe("patch-b")
  })

  test("mixed: multi-edit file keeps last patch while single-edit file keeps its own", () => {
    const result = accumulateDiffs([
      edit("src/a.ts", { additions: 1, deletions: 0, patch: "patch-a1" }),
      edit("src/b.ts", { additions: 2, deletions: 1, patch: "patch-b" }),
      edit("src/a.ts", { additions: 3, deletions: 2, patch: "patch-a2" }),
    ])

    expect(result).toHaveLength(2)
    // a.ts: multi-edit — last patch kept, sums accumulated
    const a = result.find((d) => d.file === "src/a.ts")!
    expect(a.patch).toBe("patch-a2")
    expect(a.additions).toBe(4)
    expect(a.deletions).toBe(2)
    expect(a.status).toBe("modified")
    // b.ts: single-edit — patch preserved
    const b = result.find((d) => d.file === "src/b.ts")!
    expect(b.patch).toBe("patch-b")
    expect(b.additions).toBe(2)
    expect(b.deletions).toBe(1)
  })

  test("uses title as the output file path when available", () => {
    const result = accumulateDiffs([edit("src/a.ts", { title: "relative/a.ts" })])
    expect(result[0].file).toBe("relative/a.ts")
  })

  test("empty input returns empty output", () => {
    expect(accumulateDiffs([])).toEqual([])
  })

  test("multi-edit sums diverge from net diff (documents flash risk)", () => {
    // A file edited 3 times: +3/-1, +2/-4, +1/-0
    // accumulateDiffs sums: +6/-5
    // A real git net diff might be +2/-1 (or anything else)
    // This divergence is what the user sees as a "flash" when the client
    // fallback briefly replaces the server's net diff during a refetch.
    const result = accumulateDiffs([
      edit("src/a.ts", { additions: 3, deletions: 1, patch: "p1" }),
      edit("src/a.ts", { additions: 2, deletions: 4, patch: "p2" }),
      edit("src/a.ts", { additions: 1, deletions: 0, patch: "p3" }),
    ])
    // The fallback SUMS, not nets — this is the documented behavior that
    // makes the flash visible (different numbers than the server response).
    expect(result[0].additions).toBe(6)
    expect(result[0].deletions).toBe(5)
    // A hypothetical net diff would be lower — the client must never show
    // this stale/inflated data during a refetch. The fix is keepPreviousData
    // on the query so the fallback never fires while server data exists.
  })
})
