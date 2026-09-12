// The one-line label + diff stats for an edit/write part's row inside the
// "Edited files" group (spec B shape — see message-part-groups.ts).
//
// Extracted from message-part.tsx so the fallback chain is testable — the same
// bug class that bit the shell row (see ./shell-row.ts's module docs): while a
// part is PENDING its `input.filePath` may not be populated yet, so a naive
// chain falls through to the model's free-text title and renders prose in the
// slot where users read a filename. Whatever wins the chain is clamped, so a
// pending part can never fill the row with a sentence.

import { clampShellLabel, SHELL_ROW_MAX } from "./shell-row"

/** Longest label we render before eliding. Matches the shell row's budget. */
export const EDIT_ROW_MAX = SHELL_ROW_MAX

export interface EditRowPartLike {
  state?: {
    input?: Record<string, unknown>
    title?: unknown
    metadata?: Record<string, unknown>
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  return value as Record<string, unknown>
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** The path this part mutates: input.filePath (edit/write), input.path
 *  (patch-family), or the filediff's recorded file. undefined while pending. */
export function editRowFilePath(part: EditRowPartLike): string | undefined {
  const input = part.state?.input ?? {}
  const candidates = [input.filePath, input.path, recordOf(part.state?.metadata?.filediff)?.file]
  for (const candidate of candidates) {
    const path = nonEmpty(candidate)
    if (path) return path
  }
  return undefined
}

/** Prefer the file's basename; fall back to the (clamped) title, then the
 *  neutral placeholder. A prose title can never fill the row unclamped. */
export function editRowLabel(part: EditRowPartLike): string {
  const path = editRowFilePath(part)
  if (path) return clampShellLabel(path.split("/").pop() ?? path, EDIT_ROW_MAX)
  return clampShellLabel(nonEmpty(part.state?.title) ?? "file", EDIT_ROW_MAX)
}

/** The {additions, deletions} this part recorded, when it recorded them. */
export function editRowDiff(part: EditRowPartLike): { additions: number; deletions: number } | undefined {
  const filediff = recordOf(part.state?.metadata?.filediff)
  if (!filediff) return undefined
  const { additions, deletions } = filediff
  if (typeof additions !== "number" || typeof deletions !== "number") return undefined
  return { additions, deletions }
}
