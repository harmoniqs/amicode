// AMICODE: registers the chat file-reference resolver with session-ui's
// markdown renderer. Rides the same per-call server pick as the vault browser
// (focused server, else first healthy, else first), so a server switch is
// picked up by the very next resolution; resolutions never block render.
// Mounted under SelectedServerProviders (needs the server + global contexts);
// with the bridge unmounted no resolver is registered and pills stay pills.
import { onCleanup, onMount } from "solid-js"
import { registerFileRefResolver } from "@opencode-ai/session-ui/markdown-file-refs"
import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { amicodeGet } from "@/utils/amicode-fetch"
import { pickVaultServer } from "@/components/vault-browser-model"

export function AmicodeFileRefBridge() {
  const server = useServer()
  const global = useGlobal()
  onMount(() => {
    registerFileRefResolver(async (text) => {
      const conn = pickVaultServer({
        current: server.current,
        list: server.list,
        healthy: (c) => global.servers.health[ServerConnection.key(c)]?.healthy === true,
      })
      if (!conn) return null
      const raw = (await amicodeGet(conn, `/amicode/resolve-file?path=${encodeURIComponent(text)}`)) as
        | { ok?: boolean; found?: boolean; path?: unknown }
        | undefined
      return raw?.ok === true && raw.found === true && typeof raw.path === "string" ? raw.path : null
    })
  })
  onCleanup(() => registerFileRefResolver(undefined))
  return null
}
