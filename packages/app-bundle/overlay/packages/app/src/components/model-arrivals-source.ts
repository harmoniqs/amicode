// amicode#2000: the picker's arrivals source — fetches GET /amicode/model-
// arrivals through the overlay's amicode-fetch (per-active-server auth). Every
// failure (non-amicode host, 404, network, ok:false) resolves to `undefined` ⇒
// no "New" tags and the picker is exactly as before.
import { createMemo, createResource } from "solid-js"
import { ServerConnection, useServer } from "@/context/server"
import { amicodeGet } from "@/utils/amicode-fetch"
import { ARRIVALS_ROUTE, isNewModel, newModelKeys, parseArrivalsResponse, type ModelArrival } from "./model-arrivals"
import type { ModelRef } from "./dialog-select-model-reachability"

export function createModelArrivals() {
  const server = useServer()
  const [arrivals] = createResource(
    () => (server.current ? ServerConnection.key(server.current) : undefined),
    async (): Promise<ModelArrival[] | undefined> => {
      try {
        return parseArrivalsResponse(await amicodeGet(server.current, ARRIVALS_ROUTE))
      } catch {
        return undefined
      }
    },
  )
  const keys = createMemo(() => newModelKeys(arrivals.error ? undefined : arrivals.latest, Date.now()))
  return { isNew: (ref: ModelRef): boolean => isNewModel(keys(), ref) }
}
