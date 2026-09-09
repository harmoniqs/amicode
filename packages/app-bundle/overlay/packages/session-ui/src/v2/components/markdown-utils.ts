/**
 * markdown-utils — Shared markdown preprocessing and renderable-file-type helpers.
 *
 * Consolidates the three divergent copies of `preprocessMarkdown` into one
 * canonical implementation (#912 Slice 1). Also exports the single source
 * of truth for which file extensions the Preview tab can render.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// preprocessMarkdown — canonical implementation
// ---------------------------------------------------------------------------

/**
 * Convert fenced ````math` code blocks (GitHub-flavored) to `$$...$$` display
 * math blocks that the Markdown component's KaTeX extension understands.
 *
 * Canonical version: wraps with `$$\n<trimmed body>\n$$` — the newlines are
 * required for correct KaTeX display-math rendering.
 */
export function preprocessMarkdown(text: string): string {
  return text.replace(/```math\n([\s\S]*?)```/g, (_match, body: string) => `$$\n${body.trim()}\n$$`)
}

// ---------------------------------------------------------------------------
// RENDERABLE_EXTENSIONS — the single source of truth for file-type filtering
// ---------------------------------------------------------------------------

/**
 * File extensions the Preview tab can render, grouped by category.
 * This is the single source of truth — Slices 2, 3, and 5 import from here.
 *
 * Note: `.mdx` is explicitly excluded (deferred — add later if needed).
 */
export const RENDERABLE_EXTENSIONS = {
  markdown: [".md", ".markdown"] as const,
  images: [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp"] as const,
  pdf: [".pdf"] as const,
} as const

/** Flat set of all renderable extensions for O(1) lookup. */
const ALL_RENDERABLE = new Set<string>([
  ...RENDERABLE_EXTENSIONS.markdown,
  ...RENDERABLE_EXTENSIONS.images,
  ...RENDERABLE_EXTENSIONS.pdf,
])

/**
 * Check whether a filename has a renderable extension.
 * Case-insensitive. Returns false for dotfiles without a real name
 * (e.g. `.md` is a dotfile, not a markdown file).
 */
export function isRenderable(filename: string): boolean {
  const basename = filename.includes("/") ? filename.split("/").pop()! : filename
  const dotIndex = basename.lastIndexOf(".")
  // No extension, or dotfile with no name part (e.g. ".gitignore", ".md")
  if (dotIndex <= 0) return false
  const ext = basename.slice(dotIndex).toLowerCase()
  return ALL_RENDERABLE.has(ext)
}
