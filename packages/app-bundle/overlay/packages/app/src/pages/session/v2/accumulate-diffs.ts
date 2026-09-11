import type { SessionAssessedDiffResponse, SnapshotFileDiff } from "@opencode-ai/sdk/v2"

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
  assessedDiffs?: AssessedExternalDiff[]
  serverResponded: boolean
  directory: string
  home: string | undefined
  /** External status overrides from the filesystem watcher. When a file is
   *  marked "deleted" here, its status in the merged output is overridden
   *  regardless of the server's or tool-metadata's original status — applies
   *  to both in-project and cross-project files. */
  externalFileStatus?: Map<string, "deleted">
}

export type AssessedExternalDiff = SessionAssessedDiffResponse["assessments"][number]

/**
 * Merge server shadow-git diffs with tool-metadata diffs.
 *
 * Server diffs are authoritative for in-project files. Server-assessed
 * external entries are the only external truth once the caller supplies an
 * assessment result. In-project tool-metadata diffs that the server excluded
 * (e.g. created + deleted = net zero) are dropped — the server's absence is
 * the authority.
 *
 * When serverResponded is false (initial load), tool metadata remains a
 * fallback only for in-project files when assessed external data is supplied.
 */
export function mergeServerAndToolDiffs(opts: MergeOpts): Array<SnapshotFileDiff & { file: string }> {
  const { serverDiffs, toolDiffs, assessedDiffs, serverResponded, directory, home, externalFileStatus } = opts
  const prefix = home && directory.startsWith(home) ? "~" + directory.slice(home.length) : directory
  const projectPrefix = prefix + "/"
  const assessedExternal = (assessedDiffs ?? [])
    .filter((diff) => diff.state === "changed" && diff.patch !== undefined)
    .map((diff) => {
      const file = toHomePath(diff.file, home, prefix)
      const status: "added" | "modified" | "deleted" = diff.status ?? "modified"
      const additions = typeof diff.additions === "number" ? diff.additions : 0
      const deletions = typeof diff.deletions === "number" ? diff.deletions : 0
      return {
        file,
        patch: diff.patch,
        additions,
        deletions,
        status,
      }
    })

  if (serverDiffs.length > 0 || serverResponded) {
    const normalizedServerDiffs = serverDiffs
      .filter((d): d is SnapshotFileDiff & { file: string } => !!d.file)
      .map((d) => {
        const normed = { ...d, file: toHomePath(d.file, home, prefix) }
        const override = externalFileStatus?.get(normed.file)
        return override ? { ...normed, status: override } : normed
      })

    if (assessedDiffs) return [...normalizedServerDiffs, ...assessedExternal]

    // Compatibility for callers that have not adopted assessed external data.
    const serverFiles = new Set(normalizedServerDiffs.map((d) => d.file))
    const legacyExternal = toolDiffs
      .filter((d) => !serverFiles.has(d.file) && !d.file.startsWith(projectPrefix))
      .map((d) => {
        const override = externalFileStatus?.get(d.file)
        return override ? { ...d, status: override } : d
      })
    return [...normalizedServerDiffs, ...legacyExternal]
  }

  // Tool metadata remains the initial fallback for in-worktree files only.
  // External rows have no current-diff authority until the server assessment settles.
  if (assessedDiffs) return [...toolDiffs.filter((d) => d.file.startsWith(projectPrefix)), ...assessedExternal]
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
