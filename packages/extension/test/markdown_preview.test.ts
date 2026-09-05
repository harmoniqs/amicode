import { describe, expect, test } from "vitest"

/**
 * Tests for #772: Markdown preview toggle.
 *
 * Tests the preprocessMarkdown utility extraction and the
 * diff style fallback logic for preview mode.
 */

// ---------------------------------------------------------------------------
// preprocessMarkdown — extracted from session-preview-tab.tsx
// ---------------------------------------------------------------------------

/**
 * Convert fenced ```math blocks to $$...$$ display math for KaTeX.
 */
function preprocessMarkdown(md: string): string {
  return md.replace(/```math\n([\s\S]*?)```/g, (_, p1) => `$$${p1}$$`)
}

describe("preprocessMarkdown", () => {
  test("converts fenced math blocks to display math", () => {
    const input = "text\n```math\nx^2 + y^2 = z^2\n```\nmore text"
    const result = preprocessMarkdown(input)
    expect(result).toBe("text\n$$x^2 + y^2 = z^2\n$$\nmore text")
  })

  test("handles multiple math blocks", () => {
    const input = "```math\na\n```\nmiddle\n```math\nb\n```"
    const result = preprocessMarkdown(input)
    expect(result).toContain("$$a\n$$")
    expect(result).toContain("$$b\n$$")
    expect(result).not.toContain("```math")
  })

  test("leaves non-math fenced code blocks untouched", () => {
    const input = "```typescript\nconst x = 1\n```"
    const result = preprocessMarkdown(input)
    expect(result).toBe(input)
  })

  test("handles empty input", () => {
    expect(preprocessMarkdown("")).toBe("")
  })

  test("handles input with no math blocks", () => {
    const input = "# Hello\nWorld\n- list item"
    expect(preprocessMarkdown(input)).toBe(input)
  })
})

// ---------------------------------------------------------------------------
// Preview mode visibility logic
// ---------------------------------------------------------------------------

describe("Preview segment visibility", () => {
  function isMarkdownFile(path: string): boolean {
    return /\.md$/i.test(path)
  }

  test("shows for .md files", () => {
    expect(isMarkdownFile("README.md")).toBe(true)
    expect(isMarkdownFile("docs/guide.md")).toBe(true)
  })

  test("shows for .MD files (case insensitive)", () => {
    expect(isMarkdownFile("FILE.MD")).toBe(true)
  })

  test("hides for non-markdown files", () => {
    expect(isMarkdownFile("app.ts")).toBe(false)
    expect(isMarkdownFile("style.css")).toBe(false)
    expect(isMarkdownFile("data.json")).toBe(false)
    expect(isMarkdownFile("script.py")).toBe(false)
  })

  test("hides for files with md in the name but not as extension", () => {
    expect(isMarkdownFile("markdown-parser.ts")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Diff style fallback logic
// ---------------------------------------------------------------------------

describe("Preview mode fallback", () => {
  type DiffStyle = "unified" | "split" | "preview"

  /**
   * Resolve the effective diff style: if preview is selected but the file
   * isn't markdown, fall back to the last non-preview style.
   */
  function resolveEffectiveDiffStyle(
    selected: DiffStyle,
    isMarkdown: boolean,
    lastDiffMode: "unified" | "split",
  ): DiffStyle {
    if (selected === "preview" && !isMarkdown) {
      return lastDiffMode
    }
    return selected
  }

  test("returns preview for .md files when preview is selected", () => {
    expect(resolveEffectiveDiffStyle("preview", true, "split")).toBe("preview")
  })

  test("falls back to last diff mode for non-md files when preview selected", () => {
    expect(resolveEffectiveDiffStyle("preview", false, "split")).toBe("split")
    expect(resolveEffectiveDiffStyle("preview", false, "unified")).toBe("unified")
  })

  test("returns unified/split regardless of file type", () => {
    expect(resolveEffectiveDiffStyle("unified", true, "split")).toBe("unified")
    expect(resolveEffectiveDiffStyle("split", false, "unified")).toBe("split")
  })
})
