import { describe, expect, test } from "bun:test"
import { editRowDiff, editRowFilePath, editRowLabel, EDIT_ROW_MAX } from "./edit-row"

// The edit row has the shell row's bug class (see shell-row.test.ts): a PENDING
// edit part has no `input.filePath` yet, so the label chain must not fall
// through to unclamped prose in the filename slot.

describe("edit row label", () => {
  test("the file's basename always wins over the title", () => {
    expect(
      editRowLabel({
        state: { title: "Fix the context wiring", input: { filePath: "/repo/src/ui/ChatApp.svelte" } },
      }),
    ).toBe("ChatApp.svelte")
  })

  test("patch-family input.path and the filediff's file are honoured", () => {
    expect(editRowFilePath({ state: { input: { path: "/repo/a.ts" } } })).toBe("/repo/a.ts")
    expect(
      editRowFilePath({ state: { metadata: { filediff: { file: "/repo/b.ts", additions: 1, deletions: 0 } } } }),
    ).toBe("/repo/b.ts")
  })

  test("a pending part falls back to a clamped title, never raw prose", () => {
    const prose = `"${"Rephrasing the whole module so the wiring reaches the transcript and the view ".repeat(3)}"`
    const out = editRowLabel({ state: { title: prose } })
    expect(out.length).toBeLessThanOrEqual(EDIT_ROW_MAX)
    expect(out.endsWith("…")).toBe(true)
  })

  test("blank filePath does not beat a usable title", () => {
    expect(editRowLabel({ state: { title: "Write svelte-shims.d.ts", input: { filePath: "   " } } })).toBe(
      "Write svelte-shims.d.ts",
    )
  })

  test("nothing usable → the neutral placeholder, never a throw", () => {
    expect(editRowLabel({})).toBe("file")
    expect(editRowLabel({ state: {} })).toBe("file")
    expect(editRowLabel({ state: { input: {} } })).toBe("file")
  })
})

describe("edit row diff", () => {
  test("reads additions/deletions off the filediff", () => {
    expect(editRowDiff({ state: { metadata: { filediff: { file: "a.ts", additions: 14, deletions: 1 } } } })).toEqual({
      additions: 14,
      deletions: 1,
    })
  })

  test("no (or partial) filediff → undefined, never a fabricated count", () => {
    expect(editRowDiff({})).toBeUndefined()
    expect(editRowDiff({ state: { metadata: {} } })).toBeUndefined()
    expect(editRowDiff({ state: { metadata: { filediff: { file: "a.ts" } } } })).toBeUndefined()
    expect(editRowDiff({ state: { metadata: { filediff: { additions: 3 } } } })).toBeUndefined()
  })
})
