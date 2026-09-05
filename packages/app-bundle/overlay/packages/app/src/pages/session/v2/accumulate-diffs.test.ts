import { describe, expect, test } from "bun:test"
import { accumulateDiffs, applyRenames, mergeServerAndToolDiffs, type ToolEditPart } from "./accumulate-diffs"

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

// --- mergeServerAndToolDiffs ---

const HOME = "/Users/jj"
const DIR = "/Users/jj/harmoniqs/amicode"
const diff = (
  file: string,
  patch = "mock",
  additions = 1,
  deletions = 0,
  status: "added" | "modified" | "deleted" = "modified",
) => ({ file, patch, additions, deletions, status })

describe("mergeServerAndToolDiffs", () => {
  test("cross-project tool diffs pass through when server has responded", () => {
    const result = mergeServerAndToolDiffs({
      serverDiffs: [diff("src/foo.ts")],
      toolDiffs: [diff("~/other-project/bar.ts")],
      serverResponded: true,
      directory: DIR,
      home: HOME,
    })
    const files = result.map((d) => d.file)
    expect(files).toContain("~/harmoniqs/amicode/src/foo.ts")
    expect(files).toContain("~/other-project/bar.ts")
  })

  test("in-project files come from the server, not tool metadata (server wins)", () => {
    const result = mergeServerAndToolDiffs({
      serverDiffs: [diff("src/foo.ts", "server-patch", 10, 5)],
      toolDiffs: [diff("~/harmoniqs/amicode/src/foo.ts", "tool-patch", 3, 1)],
      serverResponded: true,
      directory: DIR,
      home: HOME,
    })
    const entry = result.find((d) => d.file.endsWith("src/foo.ts"))
    expect(entry).toBeDefined()
    expect(entry!.patch).toBe("server-patch")
    expect(entry!.additions).toBe(10)
  })

  test("in-project file absent from server (created+deleted) is excluded, not leaked as cross-project", () => {
    // The bug: file was created by the write tool, then manually deleted.
    // Server correctly has no diff (net zero). Tool metadata still has it.
    // The old code leaked it through the cross-project filter.
    const result = mergeServerAndToolDiffs({
      serverDiffs: [],
      toolDiffs: [diff("~/harmoniqs/amicode/files-changed-test.md", "stale-patch", 3, 0, "added")],
      serverResponded: true,
      directory: DIR,
      home: HOME,
    })
    expect(result).toHaveLength(0)
  })

  test("in-project file with relative path absent from server is also excluded", () => {
    const result = mergeServerAndToolDiffs({
      serverDiffs: [],
      toolDiffs: [diff("~/harmoniqs/amicode/src/temp.ts")],
      serverResponded: true,
      directory: DIR,
      home: HOME,
    })
    expect(result).toHaveLength(0)
  })

  test("fallback: all tool diffs shown when server has not responded", () => {
    const result = mergeServerAndToolDiffs({
      serverDiffs: [],
      toolDiffs: [
        diff("~/harmoniqs/amicode/src/foo.ts"),
        diff("~/other/bar.ts"),
      ],
      serverResponded: false,
      directory: DIR,
      home: HOME,
    })
    expect(result).toHaveLength(2)
  })

  test("dedup by normalized path — server wins on conflict", () => {
    const result = mergeServerAndToolDiffs({
      serverDiffs: [diff("/Users/jj/harmoniqs/amicode/src/foo.ts")],
      toolDiffs: [diff("~/harmoniqs/amicode/src/foo.ts")],
      serverResponded: true,
      directory: DIR,
      home: HOME,
    })
    expect(result).toHaveLength(1)
  })
})

// --- applyRenames ---

describe("applyRenames", () => {
  test("renames a file path when it appears in the rename map", () => {
    const diffs = [diff("~/harmoniqs/amicode/test.md")]
    const renames = new Map([["~/harmoniqs/amicode/test.md", "~/harmoniqs/opencode/test.md"]])
    const result = applyRenames(diffs, renames)
    expect(result).toHaveLength(1)
    expect(result[0].file).toBe("~/harmoniqs/opencode/test.md")
  })

  test("leaves files unchanged when not in the rename map", () => {
    const diffs = [diff("~/harmoniqs/amicode/src/foo.ts")]
    const renames = new Map([["~/harmoniqs/amicode/test.md", "~/harmoniqs/opencode/test.md"]])
    const result = applyRenames(diffs, renames)
    expect(result[0].file).toBe("~/harmoniqs/amicode/src/foo.ts")
  })

  test("returns diffs unchanged when rename map is empty", () => {
    const diffs = [diff("~/harmoniqs/amicode/test.md"), diff("~/other/bar.ts")]
    const result = applyRenames(diffs, new Map())
    expect(result).toEqual(diffs)
  })

  test("preserves all other diff fields (patch, additions, deletions, status)", () => {
    const diffs = [diff("~/old/path.ts", "the-patch", 5, 3, "modified")]
    const renames = new Map([["~/old/path.ts", "~/new/path.ts"]])
    const result = applyRenames(diffs, renames)
    expect(result[0].file).toBe("~/new/path.ts")
    expect(result[0].patch).toBe("the-patch")
    expect(result[0].additions).toBe(5)
    expect(result[0].deletions).toBe(3)
    expect(result[0].status).toBe("modified")
  })

  test("handles multiple renames in one pass", () => {
    const diffs = [diff("~/a/one.ts"), diff("~/b/two.ts")]
    const renames = new Map([
      ["~/a/one.ts", "~/c/one.ts"],
      ["~/b/two.ts", "~/d/two.ts"],
    ])
    const result = applyRenames(diffs, renames)
    expect(result[0].file).toBe("~/c/one.ts")
    expect(result[1].file).toBe("~/d/two.ts")
  })
})

// --- move-back-to-project: full round-trip scenario ---

describe("round-trip move: project → cross-project → back to project", () => {
  test("file moved out then back is visible when server includes it after refetch", () => {
    // Step 1: file created in-project, server has it
    const step1 = mergeServerAndToolDiffs({
      serverDiffs: [diff("~/harmoniqs/amicode/test.md", "patch", 2, 0, "added")],
      toolDiffs: [diff("~/harmoniqs/amicode/test.md", "patch", 2, 0, "added")],
      serverResponded: true,
      directory: DIR,
      home: HOME,
    })
    expect(step1).toHaveLength(1)
    expect(step1[0].file).toBe("~/harmoniqs/amicode/test.md")

    // Step 2: file moved to opencode — rename map transforms tool diff
    const renames1 = new Map([["~/harmoniqs/amicode/test.md", "~/harmoniqs/opencode/test.md"]])
    const toolDiffsStep2 = applyRenames(
      [diff("~/harmoniqs/amicode/test.md", "patch", 2, 0, "added")],
      renames1,
    )
    const step2 = mergeServerAndToolDiffs({
      serverDiffs: [],  // server no longer has it (moved away)
      toolDiffs: toolDiffsStep2,
      serverResponded: true,
      directory: DIR,
      home: HOME,
    })
    expect(step2).toHaveLength(1)
    expect(step2[0].file).toBe("~/harmoniqs/opencode/test.md")

    // Step 3: file moved back — rename chain resolves to original path
    // After chain resolution: amicode/test.md → amicode/test.md (identity)
    const renames2 = new Map([
      ["~/harmoniqs/amicode/test.md", "~/harmoniqs/amicode/test.md"],
      ["~/harmoniqs/opencode/test.md", "~/harmoniqs/amicode/test.md"],
    ])
    const toolDiffsStep3 = applyRenames(
      [diff("~/harmoniqs/amicode/test.md", "patch", 2, 0, "added")],
      renames2,
    )
    // Tool diff is back at the in-project path
    expect(toolDiffsStep3[0].file).toBe("~/harmoniqs/amicode/test.md")

    // With server refetch (diff_version bumped), server includes the file again
    const step3 = mergeServerAndToolDiffs({
      serverDiffs: [diff("~/harmoniqs/amicode/test.md", "patch", 2, 0, "added")],
      toolDiffs: toolDiffsStep3,
      serverResponded: true,
      directory: DIR,
      home: HOME,
    })
    expect(step3).toHaveLength(1)
    expect(step3[0].file).toBe("~/harmoniqs/amicode/test.md")
  })

  test("file moved back DISAPPEARS when server has NOT refetched (the bug this fix addresses)", () => {
    // Rename map resolves to in-project, but server still has stale empty response
    const renames = new Map([
      ["~/harmoniqs/amicode/test.md", "~/harmoniqs/amicode/test.md"],
    ])
    const toolDiffs = applyRenames(
      [diff("~/harmoniqs/amicode/test.md", "patch", 2, 0, "added")],
      renames,
    )
    // Server hasn't refetched — stale empty response
    const result = mergeServerAndToolDiffs({
      serverDiffs: [],
      toolDiffs,
      serverResponded: true,
      directory: DIR,
      home: HOME,
    })
    // Without the diff_version bump, the file is gone (server is authoritative for in-project)
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// latchWhileBusy — prevent brief falsy gaps from unmounting components
// ---------------------------------------------------------------------------

describe("latchWhileBusy", () => {
  // Pure-function version of the latching memo used in ReviewPanelV2.
  // The real code uses createMemo with a prev accumulator; we test the
  // underlying logic here as a plain function.
  function latchWhileBusy<T>(current: T | undefined, prev: T | undefined, isBusy: boolean): T | undefined {
    if (!current && prev && isBusy) return prev
    return current
  }

  test("returns current value when it is truthy", () => {
    expect(latchWhileBusy("foo.ts", undefined, true)).toBe("foo.ts")
    expect(latchWhileBusy("foo.ts", "bar.ts", true)).toBe("foo.ts")
    expect(latchWhileBusy("foo.ts", undefined, false)).toBe("foo.ts")
  })

  test("latches previous value when current goes falsy and agent is busy", () => {
    expect(latchWhileBusy(undefined, "foo.ts", true)).toBe("foo.ts")
  })

  test("does NOT latch when agent is idle (allows real empty state)", () => {
    expect(latchWhileBusy(undefined, "foo.ts", false)).toBeUndefined()
  })

  test("does NOT latch when there is no previous value", () => {
    expect(latchWhileBusy(undefined, undefined, true)).toBeUndefined()
  })

  test("latches object values the same way", () => {
    const prevDiff = { file: "foo.ts", additions: 5, deletions: 2 }
    expect(latchWhileBusy(undefined, prevDiff, true)).toBe(prevDiff)
    expect(latchWhileBusy(undefined, prevDiff, false)).toBeUndefined()
    const newDiff = { file: "foo.ts", additions: 6, deletions: 3 }
    expect(latchWhileBusy(newDiff, prevDiff, true)).toBe(newDiff)
  })
})
