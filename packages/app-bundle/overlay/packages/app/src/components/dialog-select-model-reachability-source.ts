// amicode#1986 (#1979 S3): the picker's reachability data source — fetches the
// S2 snapshot through the overlay's amicode-fetch (per-active-server Basic
// auth) and exposes a Re-check. Every failure (non-amicode host, 404, network,
// ok:false) resolves to `undefined` ⇒ the pure merge passes the list through
// untouched, so the picker degrades to exactly upstream behaviour.
import { createResource, createSignal } from "solid-js"
import { ServerConnection, useServer } from "@/context/server"
import { amicodeGet, amicodePost } from "@/utils/amicode-fetch"
import {
  parseReachabilityResponse,
  REACHABILITY_REFRESH_ROUTE,
  REACHABILITY_ROUTE,
  type ReachabilitySnapshot,
} from "./dialog-select-model-reachability"

export function createModelReachability() {
  const server = useServer()
  const [snapshot, { refetch }] = createResource(
    () => (server.current ? ServerConnection.key(server.current) : undefined),
    async (): Promise<ReachabilitySnapshot | undefined> => {
      try {
        return parseReachabilityResponse(await amicodeGet(server.current, REACHABILITY_ROUTE))
      } catch {
        return undefined
      }
    },
  )
  const [showUnavailable, setShowUnavailable] = createSignal(false)
  const [rechecking, setRechecking] = createSignal(false)

  return {
    /** undefined ⇒ passthrough (no data / route unavailable). */
    snapshot: (): ReachabilitySnapshot | undefined => (snapshot.error ? undefined : snapshot.latest),
    showUnavailable,
    setShowUnavailable,
    rechecking,
    refetch: () => void refetch(),
    recheck: async () => {
      if (rechecking()) return
      setRechecking(true)
      try {
        await amicodePost(server.current, REACHABILITY_REFRESH_ROUTE, {})
      } catch {
        // a rate-limited / failed refresh still re-reads whatever the cache holds
      } finally {
        setRechecking(false)
        void refetch()
      }
    },
  }
}

export type ModelReachabilityState = ReturnType<typeof createModelReachability>
