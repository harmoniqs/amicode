// renderer-dispatch.ts — Pure function mapping file extensions to renderer
// kinds for the Preview tab content area (#726).
//
// Design: side-effect-free, easy to test, easy to extend. Unknown extensions
// fall back to "editor" (plain text with line numbers).

// ── Renderer kinds ──────────────────────────────────────────────────────────

export type RendererKind = "markdown" | "pdf" | "image" | "editor"

// ── Extension → Renderer mapping ────────────────────────────────────────────

const EXTENSION_MAP: Record<string, RendererKind> = {
  ".md": "markdown",
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".svg": "image",
  ".gif": "image",
  ".webp": "image",
  // TeX family → editor
  ".tex": "editor",
  ".bib": "editor",
  ".tikz": "editor",
  ".sty": "editor",
  ".cls": "editor",
  // Text/log → editor
  ".txt": "editor",
  ".log": "editor",
}

/**
 * Map a file extension (including the leading dot) to a renderer kind.
 * Case-insensitive. Unknown extensions fall back to "editor" (plain text).
 */
export function rendererForExtension(ext: string): RendererKind {
  return EXTENSION_MAP[ext.toLowerCase()] ?? "editor"
}

// ── Toolbar config per renderer kind ────────────────────────────────────────

export interface ToolbarConfig {
  /** Show zoom controls. */
  zoom: boolean
  /** Show save indicator (for editable files). */
  save: boolean
  /** Show TeX Build button. */
  build: boolean
  /** Mode toggle type: "preview-editor" for .md, null for others. */
  modeToggle: "preview-editor" | null
}

/**
 * Return the toolbar configuration for a renderer kind.
 * @param kind - The renderer kind
 * @param texAvailable - Whether a TeX compiler is detected (for the Build button)
 */
export function toolbarForRenderer(kind: RendererKind, texAvailable: boolean): ToolbarConfig {
  switch (kind) {
    case "markdown":
      return { zoom: true, save: false, build: false, modeToggle: "preview-editor" }
    case "pdf":
      return { zoom: true, save: false, build: false, modeToggle: null }
    case "image":
      return { zoom: true, save: false, build: false, modeToggle: null }
    case "editor":
      return { zoom: false, save: true, build: texAvailable, modeToggle: null }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the extension (including dot, lowercase) from a file path. */
export function extFromPath(path: string): string {
  const lastDot = path.lastIndexOf(".")
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  if (lastDot <= lastSlash) return ""
  return path.slice(lastDot).toLowerCase()
}

/** Whether a file extension maps to a read-only renderer. */
export function isReadOnly(ext: string): boolean {
  const lower = ext.toLowerCase()
  const kind = rendererForExtension(lower)
  return kind === "pdf" || kind === "image" || lower === ".log"
}
