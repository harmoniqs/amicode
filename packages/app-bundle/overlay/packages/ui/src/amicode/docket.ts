import { editRowDiff, editRowFilePath } from "./edit-row"

/* The docket — collapsed tool-group rows carry their EVIDENCE inline (Aaron
 * 2026-09-04): file tokens with ±, pattern tokens with repeat counts, shell
 * tallies. Pure and testable; the group components only render. A docket is a
 * bounded list: the first `max` unique tokens plus a `more` count, so a
 * hundred-file run still fits on one line. Parts are structural (tool name +
 * state) — the same shape edit-row.ts accepts — so tests need no SDK types.
 *
 * Lives beside edit-row.ts (same import seam) and takes its basename inline
 * (core's getFilename is a path.split("/").pop()) so the module stays free of
 * cross-package imports — the extension vitest lane runs it headless. */

/** Basename of a path (core's getFilename semantics: everything past the
 *  final slash — a trailing slash yields the empty string, as upstream). */
function getFilename(path: string): string {
  return path.split("/").pop() ?? path
}

export type DocketPart = {
  tool: string
  state: { status?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> }
}

export type DocketToken =
  | { kind: "file"; name: string; dir?: string; additions?: number; deletions?: number }
  | { kind: "pattern"; text: string; count: number }
  | { kind: "dir"; text: string }

export type Docket = { tokens: DocketToken[]; more: number }

/** Cap a token list: keep the first `max`, report the rest as `more`. */
function cap(tokens: DocketToken[], max: number): Docket {
  if (tokens.length <= max) return { tokens, more: 0 }
  return { tokens: tokens.slice(0, max), more: tokens.length - max }
}

/** Edited-files docket: one token per unique target path, ± summed across
 *  repeat edits of the same file. Parts without a path (pending) skip. */
export function editDocket(parts: DocketPart[], max = 3): Docket {
  const byPath = new Map<string, { dir: string; additions: number; deletions: number }>()
  for (const part of parts) {
    const path = editRowFilePath(part)
    if (!path) continue
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined
    const diff = editRowDiff(part)
    const entry = byPath.get(path) ?? { dir: dir ?? "", additions: 0, deletions: 0 }
    entry.additions += diff?.additions ?? 0
    entry.deletions += diff?.deletions ?? 0
    byPath.set(path, entry)
  }
  const tokens: DocketToken[] = [...byPath.entries()].map(([path, d]) => ({
    kind: "file",
    name: getFilename(path),
    dir: d.dir || undefined,
    additions: d.additions || undefined,
    deletions: d.deletions || undefined,
  }))
  return cap(tokens, max)
}

/** Explored docket: reads surface as file tokens, searches as their pattern
 *  (repeat searches of one pattern merge with a count), lists as directory
 *  tokens. Order follows the run. */
export function contextDocket(parts: DocketPart[], max = 3): Docket {
  const tokens: DocketToken[] = []
  const seen = new Map<string, DocketToken>()
  const push = (key: string, token: DocketToken) => {
    if (seen.has(key)) {
      const existing = seen.get(key)!
      if (existing.kind === "pattern") existing.count++
      return
    }
    seen.set(key, token)
    tokens.push(token)
  }
  for (const part of parts) {
    const input = part.state.input ?? {}
    const filePath = typeof input.filePath === "string" ? input.filePath : undefined
    const path = typeof input.path === "string" ? input.path : "/"
    const pattern = typeof input.pattern === "string" ? input.pattern : undefined
    switch (part.tool) {
      case "read":
        if (filePath) push(filePath, { kind: "file", name: getFilename(filePath) })
        break
      case "glob":
      case "grep":
        if (pattern) push(pattern, { kind: "pattern", text: pattern, count: 1 })
        break
      case "list":
        push(path, { kind: "dir", text: path })
        break
    }
  }
  return cap(tokens, max)
}

/** Worked-in-shell docket: a tally, plus the failure count when it isn't zero. */
export function shellDocket(parts: DocketPart[]): { commands: number; failed: number } {
  const failed = parts.filter((part) => part.state.status === "error").length
  return { commands: parts.length, failed }
}
