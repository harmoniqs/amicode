import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { normalize } from "./session-diff"
import { createSummaryPatchLoader, hasBody, type SummaryDiffSource } from "./summary-patch"

// #1778 — live per-turn summaries carry each file's status and counts but no
// patch body (the engine strips patches on the wire; storage keeps them). The
// per-turn diff view fetches a patch on demand when a file is expanded, from
// the stored message. The loader is the behavior; session-turn.tsx's wiring is
// asserted on its source below (bun's test transpiler does not run Solid's
// JSX transform — the repo's component-source-assertion convention).

const PATCH = "@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n"
const stored = [
  { file: "src/app.ts", patch: PATCH, additions: 1, deletions: 1, status: "modified" as const },
  { file: "src/other.ts", patch: "@@ -0,0 +1 @@\n+other\n", additions: 1, deletions: 0, status: "added" as const },
]
// what a live message.updated carries after the wire projection
const live = stored.map(({ patch: _patch, ...rest }) => rest)
const turn = { sessionID: "ses_1", messageID: "msg_1" }

function recordingSource(answer: () => Promise<typeof stored | undefined> = async () => stored) {
  const calls: { sessionID: string; messageID: string }[] = []
  const source: SummaryDiffSource = (input) => {
    calls.push(input)
    return answer()
  }
  return { calls, source }
}

describe("per-turn diff view — patch bodies on demand (#1778, #1814 P3)", () => {
  test("a live summary's file list and counts need no fetch; only a patch-less diff needs one", () => {
    const { calls, source } = recordingSource()
    createSummaryPatchLoader(source)
    expect(live.map((diff) => [diff.file, diff.additions, diff.deletions, diff.status])).toEqual([
      ["src/app.ts", 1, 1, "modified"],
      ["src/other.ts", 1, 0, "added"],
    ])
    expect(live.map(hasBody)).toEqual([false, false])
    expect(stored.map(hasBody)).toEqual([true, true])
    expect(hasBody({ file: "a", before: "x", after: "y" })).toBe(true)
    expect(calls).toEqual([])
  })

  test("expanding a file fetches the turn's stored diffs once and renders that file's patch", async () => {
    const { calls, source } = recordingSource()
    const loader = createSummaryPatchLoader(source)

    const patch = await loader.patch({ ...turn, file: "src/app.ts", summary: live })
    expect(patch).toBe(PATCH)
    const view = normalize({ ...live[0], patch })
    expect(view.fileDiff.additionLines.join("")).toContain("new line")
    expect(view.fileDiff.deletionLines.join("")).toContain("old line")
    expect({ additions: view.additions, deletions: view.deletions, status: view.status }).toEqual({
      additions: 1,
      deletions: 1,
      status: "modified",
    })

    // a second file of the same turn — and concurrent expands — share the one fetch
    const [other, again] = await Promise.all([
      loader.patch({ ...turn, file: "src/other.ts", summary: live }),
      loader.patch({ ...turn, file: "src/app.ts", summary: live }),
    ])
    expect(other).toBe(stored[1].patch)
    expect(again).toBe(PATCH)
    expect(calls).toEqual([turn])
  })

  test("a failed fetch resolves to no patch and is retried on the next expand", async () => {
    let fail = true
    const { calls, source } = recordingSource(async () => {
      if (fail) throw new Error("offline")
      return stored
    })
    const loader = createSummaryPatchLoader(source)
    expect(await loader.patch({ ...turn, file: "src/app.ts", summary: live })).toBeUndefined()
    fail = false
    expect(await loader.patch({ ...turn, file: "src/app.ts", summary: live })).toBe(PATCH)
    expect(calls).toHaveLength(2)
  })

  test("a turn whose summary changed (a later message.updated) is fetched afresh", async () => {
    const { calls, source } = recordingSource()
    const loader = createSummaryPatchLoader(source)
    await loader.patch({ ...turn, file: "src/app.ts", summary: live })
    await loader.patch({ ...turn, file: "src/app.ts", summary: [{ ...live[0], additions: 7 }, live[1]] })
    expect(calls).toHaveLength(2)
  })

  test("without a source (a provider that cannot fetch) a patch-less diff resolves to no patch", async () => {
    expect(await createSummaryPatchLoader(undefined).patch({ ...turn, file: "src/app.ts", summary: live })).toBeUndefined()
  })
})

describe("per-turn diff view — wiring (#1778, #1814 P3)", () => {
  const turnSource = readFileSync(resolve(__dirname, "session-turn.tsx"), "utf8")
  const dataSource = readFileSync(resolve(__dirname, "../context/data.tsx"), "utf8")

  test("the data provider takes an on-demand summary-diff source and shares one loader", () => {
    expect(dataSource).toContain("onLoadSummaryDiffs?: SummaryDiffSource")
    expect(dataSource).toContain("createSummaryPatchLoader(props.onLoadSummaryDiffs)")
    expect(dataSource).toContain("summaryPatch:")
  })

  test("the accordion fetches a patch only once a patch-less file is expanded, and renders the fetched patch", () => {
    // the fetch fires from the expanded+shown edge, only for a diff without a body
    expect(turnSource).toContain("on(shown, (value) => {")
    expect(turnSource).toContain("if (!value || hasBody(diff) || fetched() !== undefined) return")
    expect(turnSource).toContain(".summaryPatch({")
    expect(turnSource).toContain("normalize(patch === undefined ? diff : { ...diff, patch })")
    expect(turnSource).toContain("fileDiff={view().fileDiff}")
    // the per-file view is no longer parsed eagerly for collapsed files
    expect(turnSource).not.toContain("const view = normalize(diff)")
  })

  test("the file list and counts render from the summary itself, with no fetch", () => {
    expect(turnSource).toContain("<DiffChanges changes={diffs()} />")
    expect(turnSource).toContain("<DiffChanges changes={diff} />")
    const memo = turnSource.slice(turnSource.indexOf("const diffs = createMemo"), turnSource.indexOf("const MAX_FILES"))
    expect(memo).not.toContain("summaryPatch")
  })
})
