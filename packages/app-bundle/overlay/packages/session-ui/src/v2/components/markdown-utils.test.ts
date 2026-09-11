import { describe, expect, test } from "bun:test"
import { preprocessMarkdown, RENDERABLE_EXTENSIONS, isRenderable } from "./markdown-utils"

/**
 * Tests for markdown-utils — the consolidated preprocessMarkdown utility
 * and renderable-file-type helpers (Slice 1 of #912).
 */

// ---------------------------------------------------------------------------
// preprocessMarkdown — canonical version uses newlines + trim
// ---------------------------------------------------------------------------

describe("preprocessMarkdown", () => {
  test("converts fenced math blocks to display math with newlines and trim", () => {
    const input = "text\n```math\nx^2 + y^2 = z^2\n```\nmore text"
    const result = preprocessMarkdown(input)
    // Canonical: $$\n<trimmed body>\n$$
    expect(result).toBe("text\n$$\nx^2 + y^2 = z^2\n$$\nmore text")
  })

  test("trims whitespace inside math blocks", () => {
    const input = "```math\n  x + y  \n```"
    const result = preprocessMarkdown(input)
    expect(result).toBe("$$\nx + y\n$$")
  })

  test("handles multiple math blocks", () => {
    const input = "```math\na\n```\nmiddle\n```math\nb\n```"
    const result = preprocessMarkdown(input)
    expect(result).toContain("$$\na\n$$")
    expect(result).toContain("$$\nb\n$$")
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
// RENDERABLE_EXTENSIONS — the single source of truth for file-type filtering
// ---------------------------------------------------------------------------

describe("RENDERABLE_EXTENSIONS", () => {
  test("has markdown category with .md and .markdown", () => {
    expect(RENDERABLE_EXTENSIONS.markdown).toContain(".md")
    expect(RENDERABLE_EXTENSIONS.markdown).toContain(".markdown")
  })

  test("has images category with all expected formats", () => {
    const images = RENDERABLE_EXTENSIONS.images as readonly string[]
    expect(images).toContain(".png")
    expect(images).toContain(".jpg")
    expect(images).toContain(".jpeg")
    expect(images).toContain(".gif")
    expect(images).toContain(".svg")
    expect(images).toContain(".webp")
    expect(images).toContain(".ico")
    expect(images).toContain(".bmp")
  })

  test("has pdf category", () => {
    expect(RENDERABLE_EXTENSIONS.pdf).toContain(".pdf")
  })

  test("does NOT include .mdx (deferred)", () => {
    expect(RENDERABLE_EXTENSIONS.markdown).not.toContain(".mdx")
  })
})

// ---------------------------------------------------------------------------
// isRenderable — file type detection helper
// ---------------------------------------------------------------------------

describe("isRenderable", () => {
  test("accepts .md files", () => {
    expect(isRenderable("README.md")).toBe(true)
    expect(isRenderable("docs/guide.md")).toBe(true)
  })

  test("accepts .markdown files", () => {
    expect(isRenderable("notes.markdown")).toBe(true)
  })

  test("accepts image files", () => {
    expect(isRenderable("photo.png")).toBe(true)
    expect(isRenderable("logo.jpg")).toBe(true)
    expect(isRenderable("icon.jpeg")).toBe(true)
    expect(isRenderable("animation.gif")).toBe(true)
    expect(isRenderable("vector.svg")).toBe(true)
    expect(isRenderable("modern.webp")).toBe(true)
    expect(isRenderable("favicon.ico")).toBe(true)
    expect(isRenderable("bitmap.bmp")).toBe(true)
  })

  test("accepts .pdf files", () => {
    expect(isRenderable("paper.pdf")).toBe(true)
  })

  test("rejects non-renderable files", () => {
    expect(isRenderable("app.ts")).toBe(false)
    expect(isRenderable("style.css")).toBe(false)
    expect(isRenderable("data.json")).toBe(false)
    expect(isRenderable("script.py")).toBe(false)
    expect(isRenderable("binary.exe")).toBe(false)
  })

  test("rejects files with renderable-like names but wrong extension", () => {
    expect(isRenderable("markdown-parser.ts")).toBe(false)
    expect(isRenderable("pdf-viewer.js")).toBe(false)
  })

  test("handles case-insensitive extensions", () => {
    expect(isRenderable("FILE.MD")).toBe(true)
    expect(isRenderable("IMAGE.PNG")).toBe(true)
    expect(isRenderable("DOC.PDF")).toBe(true)
  })

  test("handles files with no extension", () => {
    expect(isRenderable("Makefile")).toBe(false)
    expect(isRenderable("README")).toBe(false)
  })

  test("handles dotfiles", () => {
    expect(isRenderable(".gitignore")).toBe(false)
    expect(isRenderable(".md")).toBe(false) // This is a dotfile named ".md", not a markdown file
  })
})
