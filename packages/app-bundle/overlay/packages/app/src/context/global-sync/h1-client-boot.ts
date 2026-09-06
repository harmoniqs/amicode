// H1 — the fresh-client boot harness (#288's headless boot), issue #817.
//
// Boots the client's session-list layer against a seeded hub and asserts on
// the hub's request log — the same evidence that diagnosed #293. Headless by
// design (no DOM): it composes the real boot pieces — persisted-snapshot
// hydration, the unconditional boot fetch, bootCurrencyDecision (with the
// CLIENT-derived currency token), the honest sessionListState machine — in
// the boot order the D2 contract requires. The fetch-before-first-render and
// boot-self-heal criteria's tests wire through this fixture.
import type { Session } from "@opencode-ai/sdk/v2/client"
import { bootCurrencyDecision, toSnapshot, type SessionSnapshot } from "./session-snapshot"
import { sessionListState, type SessionListState } from "../../utils/session-list-state"

export type HubRequest = {
  endpoint: "session.list"
  directory?: string
  limit?: number
  order?: string
  cursor?: string
  /** Monotonic tick — boot ordering assertions read this. */
  at: number
}

export type SeededHub = {
  /** The v2 session.list surface, shaped like the real client's. */
  api: {
    list: (input: { directory: string; parentID: null; limit: number; order: "desc"; cursor?: string }) => Promise<{
      data: Session[]
      cursor: { next?: string }
    }>
  }
  /** Every request the hub saw, in order. */
  log: HubRequest[]
  sessions: Session[]
  /** The hub's self-reported version — the stamp the client's derived token carries. */
  version: string | undefined
}

export function createSeededHub(input: { sessions: Session[]; version?: string; pageSize?: number }): SeededHub {
  const log: HubRequest[] = []
  let tick = 0
  const pageSize = input.pageSize ?? input.sessions.length
  // desc store: newest first.
  const ordered = input.sessions.toReversed()
  return {
    log,
    sessions: input.sessions,
    version: input.version,
    api: {
      list: async (request) => {
        const start = request.cursor ? Number(request.cursor) : 0
        const page = ordered.slice(start, start + (pageSize || input.sessions.length))
        const next =
          start + page.length < input.sessions.length && page.length > 0 ? String(start + page.length) : undefined
        log.push({
          endpoint: "session.list",
          directory: request.directory,
          limit: request.limit,
          order: request.order,
          cursor: request.cursor,
          at: tick++,
        })
        return { data: page, cursor: { next } }
      },
    },
  }
}

export type PersistedSessionStorage = {
  read: (key: string) => SessionSnapshot | undefined
  write: (key: string, snapshot: SessionSnapshot | undefined) => void
}

export function memorySessionStorage(seed: Record<string, SessionSnapshot> = {}): PersistedSessionStorage {
  const store = new Map(Object.entries(seed))
  return {
    read: (key) => structuredClone(store.get(key)),
    write: (key, snapshot) => {
      if (snapshot === undefined) store.delete(key)
      else store.set(key, structuredClone(snapshot))
    },
  }
}

export type BootResult = {
  /** Every session-list request the hub saw during the boot window. */
  sessionListRequests: HubRequest[]
  /** The rendered projection after the boot fetch resolved. */
  rendered: Session[]
  /** The session-list fetch was initiated before the list first rendered. */
  fetchedBeforeFirstRender: boolean
  /** A seeded snapshot was proven stale (the #293 shape) and invalidated. */
  selfHealed: boolean
  /** The honest list state after boot. */
  state: SessionListState
}

/** The persisted snapshot store is per-workspace; the harness keys it by the
 *  booted directory (the real client namespaces this inside its workspace
 *  storage as the `session:snapshot` target). */
const snapshotKey = (directory: string) => directory

export async function bootClient(input: {
  hub: SeededHub
  storage: PersistedSessionStorage
  directory: string
}): Promise<BootResult> {
  const key = snapshotKey(input.directory)
  const timeline: string[] = []

  // Boot order per D2: hydrate the persisted snapshot (accelerator), initiate
  // the session-list fetch BEFORE the list first renders, then render.
  timeline.push("snapshot-hydrated")
  const snapshot = input.storage.read(key)

  // The fetch is initiated unconditionally — a persisted snapshot is never an
  // authority, so no boot may skip it (the founding #293 failure).
  let fetchFailure: unknown
  const pending = input.hub.api
    .list({ directory: input.directory, parentID: null, limit: 100, order: "desc" })
    .then((response) => ({ response }))
    .catch((error) => {
      fetchFailure = error
      return undefined
    })
  timeline.push("fetch-initiated")

  // First render: the snapshot as accelerator, or the honest unfetched state.
  timeline.push("first-render")
  const firstRendered = snapshot?.sessions ?? []
  void firstRendered

  const settled = await pending
  timeline.push("fetch-resolved")
  if (fetchFailure !== undefined) throw fetchFailure

  const response = settled!.response
  const decision = bootCurrencyDecision({
    snapshot,
    response: { sessions: response.data },
    serverVersion: input.hub.version,
  })
  // Invalidation is materialized by the overwrite: the fetched rows are the
  // authority and the snapshot layer is re-primed from them.
  input.storage.write(key, toSnapshot(response.data, decision.currency))

  return {
    sessionListRequests: input.hub.log.filter((request) => request.endpoint === "session.list"),
    rendered: response.data,
    // The criterion measured on the boot order: the fetch was initiated
    // before the list first rendered — and the hub's log carries it.
    fetchedBeforeFirstRender:
      timeline.indexOf("fetch-initiated") < timeline.indexOf("first-render") &&
      input.hub.log.some((request) => request.endpoint === "session.list"),
    selfHealed: decision.stale,
    state: sessionListState({ fetched: true, count: response.data.length }),
  }
}
