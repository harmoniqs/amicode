import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { diffs, message } from "./diffs"

const item = {
  file: "src/app.ts",
  patch: "@@ -1 +1 @@\n-old\n+new\n",
  additions: 1,
  deletions: 1,
  status: "modified",
} satisfies FileDiffInfo & SnapshotFileDiff

describe("diffs", () => {
  test("keeps valid arrays", () => {
    expect(diffs([item])).toEqual([item])
  })

  test("wraps a single diff object", () => {
    expect(diffs(item)).toEqual([item])
  })

  test("reads keyed diff objects", () => {
    expect(diffs({ a: item })).toEqual([item])
  })

  test("drops invalid entries", () => {
    expect(
      diffs([
        item,
        { file: "src/bad.ts", patch: 42, additions: 1, deletions: 1 },
        { file: "src/bad.ts", additions: "1", deletions: 1 },
        { patch: item.patch, additions: 1, deletions: 1 },
      ]),
    ).toEqual([item])
  })

  // #1778 (amicode overlay): a live summary's diffs carry no patch body — the
  // engine strips it on the wire, and the per-turn diff view fetches it on
  // demand. A patch-less diff (file, status, counts) is valid, not dropped:
  // before, the whole live file list vanished.
  test("keeps a patch-less diff — the live wire form", () => {
    const { patch: _patch, ...wire } = item
    expect(diffs([item, wire, { file: "src/new.ts", additions: 4, deletions: 0 }])).toEqual([
      item,
      wire,
      { file: "src/new.ts", additions: 4, deletions: 0 },
    ])
  })
})

describe("message", () => {
  test("normalizes user summaries with object diffs", () => {
    const input = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      summary: {
        title: "Edit",
        diffs: { a: item },
      },
    } as unknown as Message

    expect(message(input)).toMatchObject({
      summary: {
        title: "Edit",
        diffs: [item],
      },
    })
  })

  test("drops invalid user summaries", () => {
    const input = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      summary: true,
    } as unknown as Message

    expect(message(input)).toMatchObject({ summary: undefined })
  })

  test("a live message.updated summary keeps its file list and counts without patch bodies (#1778)", () => {
    const wire = [
      { file: "src/app.ts", additions: 1, deletions: 1, status: "modified" },
      { file: "src/new.ts", additions: 4, deletions: 0, status: "added" },
    ]
    const input = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      summary: { title: "Edit", diffs: wire },
    } as unknown as Message

    // unchanged: the normalizer returns the very same message
    expect(message(input)).toBe(input)
  })
})

describe("directory data provider — on-demand summary patches (#1778)", () => {
  const source = readFileSync(resolve(__dirname, "../pages/directory-layout.tsx"), "utf8")

  test("supplies the per-turn diff view's patch source from the stored message", () => {
    expect(source).toContain("onLoadSummaryDiffs={loadSummaryDiffs}")
    expect(source).toContain(".client.session.message({ sessionID, messageID })")
    expect(source).toContain("summary?.diffs")
  })
})
