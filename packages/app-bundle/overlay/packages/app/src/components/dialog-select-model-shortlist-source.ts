// amicode#1987 (#1979 S4): the picker's deployment config source — fetches
// GET /amicode/model-picker (model.recommended / model.allowlist) through the
// overlay's amicode-fetch. Every failure (non-amicode host, 404, network,
// ok:false) resolves to `undefined` ⇒ no recommended, no allowlist: the short
// list is favorites + recents only and nothing is filtered.
import { createResource } from "solid-js"
import { ServerConnection, useServer } from "@/context/server"
import { amicodeGet } from "@/utils/amicode-fetch"
import { parseShortlistConfig, SHORTLIST_CONFIG_ROUTE, type ShortlistConfig } from "./dialog-select-model-shortlist"

export function createModelShortlistConfig() {
  const server = useServer()
  const [config] = createResource(
    () => (server.current ? ServerConnection.key(server.current) : undefined),
    async (): Promise<ShortlistConfig | undefined> => {
      try {
        return parseShortlistConfig(await amicodeGet(server.current, SHORTLIST_CONFIG_ROUTE))
      } catch {
        return undefined
      }
    },
  )
  return (): ShortlistConfig | undefined => (config.error ? undefined : config.latest)
}
