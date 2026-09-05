import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"

export type ToolEditPart = {
  file: string
  title?: string
  patch?: string
  additions: number
  deletions: number
}

/**
 * Normalize a file path to ~/... form for consistent dedup across sources.
 */
export function toHomePath(p: string, home: string | undefined, prefix: string): string {
  if (p.startsWith("~/")) return p
  if (home && p.startsWith(home)) return "~" + p.slice(home.length)
  if (!p.startsWith("/")) return `${prefix}/${p}`
  return p
}

export interface MergeOpts {
  serverDiffs: SnapshotFileDiff[]
  toolDiffs: Array<SnapshotFileDiff & { file: string }>
  serverResponded: boolean
  directory: string
  home: string | undefined
}

/**
 * Merge server shadow-git diffs with tool-metadata diffs.
 *
 * Server diffs are authoritative for in-project files. Tool-metadata diffs
 * fill in cross-project files (outside the project directory) not covered
 * by the server. In-project tool-metadata diffs that the server excluded
 * (e.g. created + deleted = net zero) are dropped — the server's absence
 * is the authority.
 *
 * When serverResponded is false (initial load), all tool-metadata diffs
 * are returned as a fallback.
 */
export function mergeServerAndToolDiffs(opts: MergeOpts): Array<SnapshotFileDiff & { file: string }> {
  const { serverDiffs, toolDiffs, serverResponded, directory, home } = opts
  const prefix = home && directory.startsWith(home) ? "~" + directory.slice(home.length) : directory
  const projectPrefix = prefix + "/"

  if (serverDiffs.length > 0 || serverResponded) {
    const normalizedServerDiffs = serverDiffs
      .filter((d): d is SnapshotFileDiff & { file: string } => !!d.file)
      .map((d) => ({ ...d, file: toHomePath(d.file, home, prefix) }))

    const serverFiles = new Set(normalizedServerDiffs.map((d) => d.file))
    // Only pass through tool-metadata diffs that are BOTH absent from the
    // server set AND outside the project directory. In-project files trust
    // the server's authority — if the server excluded them (created + deleted,
    // or reverted), they should not leak through as phantom entries.
    const crossProjectDiffs = toolDiffs.filter(
      (d) => !serverFiles.has(d.file) && !d.file.startsWith(projectPrefix),
    )

    return [...normalizedServerDiffs, ...crossProjectDiffs]
  }

  return toolDiffs
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

/**
 * Apply a rename map to file diffs — replaces paths that have been moved/renamed.
 *
 * Used so that Files Changed reflects the current location of a file after a
 * sidebar move/rename, even though the tool-metadata still records the old path.
 */
export function applyRenames(
  diffs: Array<SnapshotFileDiff & { file: string }>,
  renames: Map<string, string>,
): Array<SnapshotFileDiff & { file: string }> {
  if (renames.size === 0) return diffs
  return diffs.map((d) => {
    const newPath = renames.get(d.file)
    return newPath ? { ...d, file: newPath } : d
  })
}
