// amicode-preview-file-tree.ts — Reactive state store for the Preview tab's
// project-wide file tree (#725). The extension host pushes the file list via
// "preview-file-tree" bridge message on app-ready and on refresh; the bridge
// handler adopts it into SolidJS signals.

import { createSignal } from "solid-js"

// ── Types ───────────────────────────────────────────────────────────────────

export interface PreviewEnvironment {
  files: string[]
  root: string
  name: string
  slug: string
  colorIndex: number
}

// ── State ───────────────────────────────────────────────────────────────────

const [files, setFiles] = createSignal<string[]>([])
const [root, setRoot] = createSignal<string>("")
const [env, setEnv] = createSignal<PreviewEnvironment | null>(null)

// ── Adopt ───────────────────────────────────────────────────────────────────

/** Adopt a preview-file-tree push from the extension host. */
export function adoptPreviewFileTree(
  fileList: string[],
  projectRoot: string,
  environment?: PreviewEnvironment,
): void {
  setFiles(Array.isArray(fileList) ? fileList : [])
  setRoot(typeof projectRoot === "string" ? projectRoot : "")
  setEnv(environment ?? null)
}

// ── Accessors ───────────────────────────────────────────────────────────────

/** Reactive accessor — returns the current renderable file list (relative paths). */
export function previewFileTree(): string[] {
  return files()
}

/** Reactive accessor — returns the project root directory. */
export function previewProjectRoot(): string {
  return root()
}

/** Reactive accessor — returns the resolved environment info, or null. */
export function previewEnv(): PreviewEnvironment | null {
  return env()
}

// ── Requests ────────────────────────────────────────────────────────────────

/** Post a refresh request to the extension host. */
export function requestPreviewFileTreeRefresh(): void {
  window.parent.postMessage({ source: "amicode", kind: "preview-file-tree-request" }, "*")
}
