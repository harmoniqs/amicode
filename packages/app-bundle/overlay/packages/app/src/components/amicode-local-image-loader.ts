// AMICODE: the chat local-image loader body (registered by
// amicode-file-ref-bridge.tsx). Reads `![](/abs/path.png)` bytes through the
// selected server's /file/content route and returns a data: URL session-ui can
// swap in. Total over its inputs: no selected server, a failed fetch, or a
// non-image answer all resolve to null (the image stays unloaded and shows its
// alt text) — it never rejects, so a server-less moment can't surface as an
// unhandled rejection in the renderer.
import type { ServerConnection } from "@/context/server"
import { amicodeGet } from "@/utils/amicode-fetch"

type Get = (conn: ServerConnection.Any, route: string) => Promise<unknown>

export async function loadLocalImageViaServer(
  conn: ServerConnection.Any | undefined,
  path: string,
  get: Get = amicodeGet,
): Promise<string | null> {
  if (!conn) return null
  let raw: { type?: string; content?: unknown; encoding?: string; mimeType?: unknown } | undefined
  try {
    raw = (await get(conn, `/file/content?path=${encodeURIComponent(path)}`)) as typeof raw
  } catch {
    return null
  }
  if (typeof raw?.content !== "string" || raw.content === "") return null
  if (raw.type === "binary" && raw.encoding === "base64" && typeof raw.mimeType === "string" && raw.mimeType.startsWith("image/"))
    return `data:${raw.mimeType};base64,${raw.content}`
  if (raw.type === "text" && path.toLowerCase().endsWith(".svg"))
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw.content)}`
  return null
}
