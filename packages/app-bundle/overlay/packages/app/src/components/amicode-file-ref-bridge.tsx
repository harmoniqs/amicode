// AMICODE: registers the chat file-reference resolver with session-ui's
// markdown renderer. Rides the same per-call server pick as the vault browser
// (focused server, else first healthy, else first), so a server switch is
// picked up by the very next resolution; resolutions never block render.
// Mounted under SelectedServerProviders (needs the server + global contexts);
// with the bridge unmounted no resolver is registered and pills stay pills.
import { onCleanup, onMount } from "solid-js"
import { registerFileRefResolver } from "@opencode-ai/session-ui/markdown-file-refs"
import { registerLocalImageLoader } from "@opencode-ai/session-ui/markdown-local-images"
import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { amicodeGet } from "@/utils/amicode-fetch"
import { loadLocalImageViaServer } from "./amicode-local-image-loader"
import { pickVaultServer } from "@/components/vault-browser-model"

export function AmicodeFileRefBridge() {
  const server = useServer()
  const global = useGlobal()
  let unregister: (() => void) | undefined
  let unregisterImages: (() => void) | undefined
  const pick = () =>
    pickVaultServer({
      current: server.current,
      list: server.list,
      healthy: (c) => global.servers.health[ServerConnection.key(c)]?.healthy === true,
    })
  onMount(() => {
    // #1845: keep the unregister handle — it clears only THIS registration,
    // so a remounting shell's late cleanup can't wipe its successor's resolver.
    unregister = registerFileRefResolver(async (text) => {
      const conn = pick()
      if (!conn) return null
      const raw = (await amicodeGet(conn, `/amicode/resolve-file?path=${encodeURIComponent(text)}`)) as
        | { ok?: boolean; found?: boolean; path?: unknown }
        | undefined
      return raw?.ok === true && raw.found === true && typeof raw.path === "string" ? raw.path : null
    })
    // Chat images authored as `![](/abs/path.png)`: read the bytes through the
    // server (the iframe can't reach its disk, and a bare <img> can't carry the
    // credential) and hand session-ui a data: URL.
    unregisterImages = registerLocalImageLoader((path) => loadLocalImageViaServer(pick(), path))
  })
  onCleanup(() => {
    unregister?.()
    unregisterImages?.()
  })
  return null
}
