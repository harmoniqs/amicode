// preview-markdown.ts — Shared markdown preprocessing for the Preview tab (#726).
// Extracted from session-preview-tab.tsx:35-37 so both the legacy preview
// and the renderer dispatch can reuse it.

/**
 * Convert ```math fenced code blocks (GitHub-flavored) to $$...$$ display math
 * blocks that the Markdown component's KaTeX extension understands.
 */
export function preprocessMarkdown(text: string): string {
  return text.replace(/```math\n([\s\S]*?)```/g, (_match, body: string) => `$$\n${body.trim()}\n$$`)
}
