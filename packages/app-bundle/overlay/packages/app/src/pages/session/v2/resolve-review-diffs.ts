import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import { accumulateDiffs, type ToolEditPart } from "./accumulate-diffs"

/**
 * Resolve which file diffs to display in the "Files Changed" panel.
 *
 * The server endpoint returns the authoritative session-scoped diff (first
 * snapshot → current state, filtered to agent-touched files). When the server
 * has responded, we trust its result — even if empty (meaning all agent edits
 * were reverted to their session-start state). The client-side `accumulateDiffs`
 * fallback runs only while the server query is still loading so the panel is
 * not blank during the initial fetch.
 */
export function resolveReviewDiffs(input: {
  serverDiffs: SnapshotFileDiff[]
  /** True once the server query has returned real data (not placeholder). */
  serverReady: boolean
  editParts: ToolEditPart[]
  directory: string
  home: string | undefined
}): Array<SnapshotFileDiff & { file: string }> {
  const { serverDiffs, serverReady, editParts, directory, home } = input
  const prefix = home && directory.startsWith(home) ? "~" + directory.slice(home.length) : directory

  if (serverReady) {
    if (serverDiffs.length === 0) return []
    return serverDiffs
      .filter((d): d is SnapshotFileDiff & { file: string } => !!d.file)
      .map((d) => ({
        ...d,
        file: d.file.startsWith("/") || d.file.startsWith("~/") ? d.file : `${prefix}/${d.file}`,
      }))
  }

  // Fallback: server hasn't responded yet — show immediate results from tool parts.
  if (!editParts.length) return []
  return accumulateDiffs(editParts)
}
