import { describe, expect, test } from "bun:test"
import { reorderPreviewTabs } from "./session-preview-tabs"

describe("Preview tab order", () => {
  test("moves a tab without replacing the other renderer hosts", () => {
    const paths = ["docs/one.md", "docs/two.md", "docs/three.md"]

    expect(reorderPreviewTabs(paths, "docs/three.md", 0)).toEqual([
      "docs/three.md",
      "docs/one.md",
      "docs/two.md",
    ])
  })
})
