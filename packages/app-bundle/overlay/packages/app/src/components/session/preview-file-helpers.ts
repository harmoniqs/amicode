// #1414: pure helpers for the file-preview component, extracted so the path and
// stale-read decisions are unit-tested away from the SolidJS/sdk wiring in
// preview-file-view.tsx.

/**
 * Is this an absolute path the extension host can act on as-is? POSIX (`/…`),
 * a Windows drive-letter (`C:\…` or `C:/…`), or a Windows UNC path (`\\…`) —
 * VS Code runs on Windows too, and joining a drive-letter path onto a directory
 * would mangle it.
 */
export function isAbsolutePreviewPath(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\")
}

/**
 * Resolve a possibly-relative preview path against the workspace directory.
 * The extension host (and the latexmk compile bridge) only accept ABSOLUTE
 * paths — a relative path posted across the bridge is silently rejected.
 */
export function toAbsolutePath(filePath: string, directory: string | undefined): string {
  if (isAbsolutePreviewPath(filePath)) return filePath
  if (!directory) return filePath
  const dir = directory.replace(/[/\\]+$/, "")
  // A directory of just "/" (or "\\") strips to "" — resolve from the root
  // rather than dropping back to a relative path the bridge would reject.
  return dir ? `${dir}/${filePath}` : `/${filePath}`
}

/**
 * Decide whether a completed, in-flight file-watcher read may be applied to the
 * view. Discard it when the previewed file has switched, a newer read has
 * superseded it, or the user began editing while it was in flight — any of
 * which would otherwise overwrite the visible editor with stale bytes.
 */
export function shouldApplyWatcherRead(args: {
  capturedPath: string
  currentPath: string
  capturedGeneration: number
  latestGeneration: number
  hasUnsavedEdits: boolean
}): boolean {
  return (
    args.capturedPath === args.currentPath &&
    args.capturedGeneration === args.latestGeneration &&
    !args.hasUnsavedEdits
  )
}

/** The Preview's read cap for text-like files: bigger files show a placeholder. */
export const MAX_TEXT_PREVIEW_SIZE = 1_000_000

/** #2130: an HTML page's cap is larger — a campaign dashboard often carries its
 *  plots as base64 data URIs, and the HTML renderer's own inlining budget
 *  (preview-html.ts MAX_INLINE_CHARS) is already far above 1 MB. Mirrored by
 *  the agent tool's size warning (extension opencode-plugin/preview_open.ts). */
export const MAX_HTML_PREVIEW_SIZE = 16_000_000

/** The size above which a text read shows "File too large to preview". */
export function previewSizeLimit(path: string): number {
  return /\.html?$/i.test(path) ? MAX_HTML_PREVIEW_SIZE : MAX_TEXT_PREVIEW_SIZE
}

/** Does a watcher/bridge path name the previewed file? The watcher reports
 *  absolute paths; the previewed path may be workspace-relative. */
export function previewPathMatches(other: string, filePath: string): boolean {
  if (other === filePath) return true
  return other.endsWith(`/${filePath}`) || filePath.endsWith(`/${other}`)
}

/**
 * #2130: is this window message a request to RE-READ the file this view shows?
 * The agent's open-in-Preview tool posts the ordinary `preview-file` open with
 * `refresh: true`; when the file is already open the open itself is a no-op,
 * so the view re-reads instead (files outside the project never reach the
 * engine's watcher). Session targeting follows preview-file-target.ts: a
 * stamped message is for its session only; an unstamped one is for everyone.
 */
export function isPreviewRefreshFor(data: unknown, filePath: string, sessionID: string | undefined): boolean {
  if (!data || typeof data !== "object") return false
  const msg = data as { source?: unknown; kind?: unknown; path?: unknown; sessionID?: unknown; refresh?: unknown }
  if (msg.source !== "amicode" || msg.kind !== "preview-file" || msg.refresh !== true) return false
  if (typeof msg.path !== "string" || msg.path === "") return false
  if (msg.sessionID !== undefined && msg.sessionID !== sessionID) return false
  return previewPathMatches(msg.path, filePath)
}
