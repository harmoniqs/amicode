// #1648: the `preview-file` bridge message used to be an un-targeted broadcast,
// so an open could land in a session view it was never meant for. The host now
// stamps the message with the target `sessionID` (the panel's settled session)
// and every listener runs it through this predicate. An ABSENT `sessionID` is
// the untargeted legacy broadcast (older hosts, draft routes, e2e harnesses)
// and still opens everywhere.

/** The path a `preview-file` message asks THIS view to open, or undefined when
 *  it is not a preview-file message, has no path, or is targeted at another
 *  session. `current` is this view's own session id (undefined on a draft). */
export const previewFilePathForSession = (data: unknown, current: string | undefined): string | undefined => {
  if (!data || typeof data !== "object") return undefined
  const msg = data as { source?: unknown; kind?: unknown; path?: unknown; sessionID?: unknown }
  if (msg.source !== "amicode" || msg.kind !== "preview-file") return undefined
  if (typeof msg.path !== "string" || msg.path === "") return undefined
  if (msg.sessionID === undefined) return msg.path
  if (typeof msg.sessionID !== "string") return undefined
  return msg.sessionID === current ? msg.path : undefined
}
