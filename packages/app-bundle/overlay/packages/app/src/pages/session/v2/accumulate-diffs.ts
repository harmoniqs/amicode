import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"

export type ToolEditPart = {
  file: string
  title?: string
  patch?: string
  additions: number
  deletions: number
}

/**
 * Accumulate file diffs from tool edit parts across a session.
 *
 * When a file is edited multiple times, individual patches cannot be naively
 * combined into one true cumulative diff. We keep the LAST edit's patch as a
 * best-effort display (the server query will replace it with the correct
 * git-based cumulative diff once it refetches), and sum additions/deletions
 * for the file list badge.
 *
 * For single-edit files the patch is preserved as-is.
 */
export function accumulateDiffs(parts: ToolEditPart[]): Array<SnapshotFileDiff & { file: string }> {
  const entries = new Map<
    string,
    {
      title: string
      patch: string | undefined
      additions: number
      deletions: number
      status: "added" | "modified" | "deleted"
      editCount: number
    }
  >()

  for (const part of parts) {
    const existing = entries.get(part.file)
    if (!existing) {
      entries.set(part.file, {
        title: part.title || part.file,
        patch: part.patch,
        additions: part.additions,
        deletions: part.deletions,
        status: "added",
        editCount: 1,
      })
    } else {
      existing.additions += part.additions
      existing.deletions += part.deletions
      existing.status = "modified"
      existing.editCount += 1
      // Keep the last edit's patch as best-effort display until the server
      // provides the real cumulative diff
      existing.patch = part.patch ?? existing.patch
    }
  }

  return [...entries.values()].map((entry) => ({
    file: entry.title,
    patch: entry.patch,
    additions: entry.additions,
    deletions: entry.deletions,
    status: entry.status,
  }))
}
