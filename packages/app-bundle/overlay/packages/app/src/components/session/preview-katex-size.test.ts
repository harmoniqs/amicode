import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// #2092: LaTeX in the sidebar's Preview tab rendered much smaller than the
// surrounding markdown. KaTeX sizes itself with `.katex { font: 1.21em … }`
// (its glyphs have a small x-height, so 1.21em is what makes them match body
// text). A `[&_.katex]:text-[…]` utility REPLACES that 1.21em instead of
// scaling it: `text-[0.9em]` left math at 0.9 × body size, roughly 25% smaller
// than KaTeX intends. The Preview markdown must leave KaTeX's own sizing alone.

const previewView = readFileSync(join(import.meta.dir, "preview-file-view.tsx"), "utf8")

describe("Preview markdown KaTeX sizing", () => {
  test("the markdown preview wrapper keeps its KaTeX display overflow guards", () => {
    expect(previewView).toContain("[&_.katex-display]:overflow-x-auto")
  })

  test("no utility overrides the font size of inline or display KaTeX", () => {
    expect(previewView).not.toMatch(/\[&_\.katex\]:text-/)
    expect(previewView).not.toMatch(/\[&_\.katex-display\]:text-/)
  })
})
