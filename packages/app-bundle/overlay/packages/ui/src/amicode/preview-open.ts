// AMICODE (#2130): parse the AMICODE_PREVIEW sentinel the amicode_open_preview
// tool appends to its output — the LAST line, shaped
// `AMICODE_PREVIEW {path,name,bytes}` (written by
// packages/extension/opencode-plugin/preview_open.ts). Pure + unit-tested,
// mirroring parseWidgetSentinel. The card uses `path` to post the existing
// session-targeted `preview-file` open.

const PREFIX = "AMICODE_PREVIEW "

export interface PreviewOpenRequest {
  path: string
  name: string
  bytes?: number
}

export function parsePreviewSentinel(output: unknown): PreviewOpenRequest | undefined {
  if (typeof output !== "string") return undefined
  const lines = output.trimEnd().split("\n")
  const last = lines[lines.length - 1]
  if (!last?.startsWith(PREFIX)) return undefined
  let raw: any
  try {
    raw = JSON.parse(last.slice(PREFIX.length))
  } catch {
    return undefined
  }
  if (typeof raw !== "object" || raw === null) return undefined
  if (typeof raw.path !== "string" || !raw.path.startsWith("/")) return undefined
  const fallbackName = raw.path.split("/").pop() || raw.path
  return {
    path: raw.path,
    name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : fallbackName,
    bytes: typeof raw.bytes === "number" && raw.bytes >= 0 ? raw.bytes : undefined,
  }
}

/** The app-window message that opens (or re-reads) a file in this session's
 *  Preview: the same `preview-file` kind the chat bridge and sidebar send
 *  (app preview-file-target.ts), stamped with the session so no other session
 *  view acts on it (#1648), plus `refresh` so an already-open file re-reads. */
export function previewOpenMessage(path: string, sessionID: string | undefined) {
  return {
    source: "amicode" as const,
    kind: "preview-file" as const,
    path,
    refresh: true,
    ...(sessionID ? { sessionID } : {}),
  }
}

/** Decide whether a card should auto-open: only when the card saw the part
 *  live (pending/running) before it completed — so replaying an old session,
 *  which mounts parts already completed, never re-opens anything — and only
 *  once per tool part. */
export function shouldAutoOpen(state: {
  sawLive: boolean
  current: string | undefined
  alreadyOpened: boolean
}): boolean {
  return state.sawLive && state.current === "completed" && !state.alreadyOpened
}
