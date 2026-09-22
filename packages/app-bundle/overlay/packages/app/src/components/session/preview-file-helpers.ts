// #1414: pure helpers for the file-preview component, extracted so the path and
// stale-read decisions are unit-tested away from the SolidJS/sdk wiring in
// preview-file-view.tsx.

/**
 * Resolve a possibly-relative preview path against the workspace directory.
 * The extension host (and the latexmk compile bridge) only accept ABSOLUTE
 * paths — a relative path posted across the bridge is silently rejected.
 */
export function toAbsolutePath(filePath: string, directory: string | undefined): string {
  if (filePath.startsWith("/")) return filePath
  const dir = (directory ?? "").replace(/\/$/, "")
  return dir ? `${dir}/${filePath}` : filePath
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
