import type { Message, UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createResource, onCleanup, untrack, type Accessor } from "solid-js"
import { shouldRefetchOnReconnect, shouldRefetchOnResync } from "@opencode-ai/ui/amicode-entity-view"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { same } from "@/utils/same"
import { isTimelineReady, loadOlderTimeline, selectUserMessages, selectVisibleUserMessages } from "./model-pure"
export { isTimelineReady, loadOlderTimeline, selectUserMessages, selectVisibleUserMessages } from "./model-pure"

const emptyUserMessages: UserMessage[] = []
const sessionFreshness = 15_000

export function createTimelineModel(input: {
  sessionID: Accessor<string | undefined>
  revertMessageID: Accessor<string | undefined>
  // #1646 (transcript self-heal) — the app's global SSE liveness signals, the
  // same ones message-timeline.tsx feeds the entity rail. Optional so the model
  // is usable without a live stream (tests, non-session hosts); omitting them
  // leaves the effects' bodies inert.
  streamConnected?: Accessor<boolean>
  forceResync?: Accessor<number>
}) {
  const serverSync = useServerSync()
  const sync = useSync()
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined

  const [resource] = createResource(
    () => input.sessionID(),
    async (id) => {
      // #1298: t0 for the paint probe — every route change into a
      // session view lands here first; the probe wrapper in session.tsx
      // stamps t1 at the new timeline's first paint.
      try {
        ;(globalThis as { __paintT0?: number }).__paintT0 = performance.now()
      } catch {}
      clearRefresh()
      if (!id) return

      // #1295c: a session with ANY data in the store never syncs on the
      // switch path at all. Two suspensions died here: the stale-force
      // join (removed earlier), and the one the rings finally exposed —
      // the switch's sync JOINING an in-flight deep prefetch (the
      // prewarmer warms open tabs to 60 messages over the wire; switching
      // mid-prefetch held the panel for the whole fetch chain while the
      // cached data sat on screen). The SSE reducers keep live sessions
      // fresh; the warm pass reconciles in the background; only a
      // genuinely-empty session takes the sync path.
      const cached = untrack(() => (sync().data.message[id]?.length ?? 0) > 0)
      if (cached) {
        // The resource resolves NOW (the cached messages are on screen);
        // the sync still runs as a TRUE background task — it may join an
        // in-flight prefetch, reconcile fresh data, fill session info —
        // nothing awaits it, so it can take as long as the wire needs.
        void sync().session.sync(id).catch(() => {})
        return
      }
      // #1297: not in the store — the MIRROR satisfies the render before
      // any task is joined: a mid-deep-warm prefetch can hold its slot for
      // many seconds (the parallel-parents fix shrinks the chains, but the
      // render must never depend on a wire chain at all when disk has the
      // data). Hydrate (an IDB read, milliseconds) → resolve; the sync
      // runs in the background as above.
      await sync().session.hydrate(id)
      if (untrack(() => (sync().data.message[id]?.length ?? 0) > 0)) {
        void sync().session.sync(id).catch(() => {})
        return
      }
      return sync().session.sync(id)
    },
  )

  // #1646 (transcript self-heal) — the transcript re-syncs above ONLY on a
  // session-ID change. A silent SSE reconnect or fan-in wedge WHILE STAYING ON
  // THE SAME SESSION drops message frames the lastEventID cursor may not
  // replay, and neither reconcileFromStatus (status only) nor the reconnect
  // bootstrap (list/status/global) reloads the viewed session's messages — so
  // the rail froze until a manual reload re-ran the resource above. Mirror the
  // entity rail's two self-heal effects (entity-rail.tsx): a forced
  // session.sync on the disconnect→connect rising edge AND on any resync-token
  // advance (the wedge case, where status stays "connected"). `prev` is a plain
  // closure `let` — each effect tracks ONLY its signal, never the store or the
  // resource, so a re-fetch's own store mutation cannot re-arm it (no loop).
  // force:true re-fetches messages and does not coalesce onto a non-forced
  // in-flight request (server-session.ts sync, #1646 forced-resolve fix).
  const forceSyncViewed = () => {
    const id = untrack(() => input.sessionID())
    if (!id) return
    void sync().session.sync(id, { force: true }).catch(() => {})
  }
  let prevConnected: boolean | undefined = undefined
  createEffect(() => {
    const signal = input.streamConnected
    if (!signal) return
    const next = signal()
    if (shouldRefetchOnReconnect(prevConnected, next)) forceSyncViewed()
    prevConnected = next
  })
  let prevResync: number | undefined = undefined
  createEffect(() => {
    const signal = input.forceResync
    if (!signal) return
    const next = signal()
    if (shouldRefetchOnResync(prevResync, next)) forceSyncViewed()
    prevResync = next
  })

  const messages = createMemo(() => {
    const id = input.sessionID()
    return id ? (sync().data.message[id] ?? []) : []
  })
  const ready = createMemo(() => {
    const id = input.sessionID()
    return !id || isTimelineReady(sync().data.message[id], serverSync().session.history.loading(id))
  })
  const userMessages = createMemo(() => selectUserMessages(messages()), emptyUserMessages, { equals: same })
  const visibleUserMessages = createMemo(
    () => {
      return selectVisibleUserMessages(userMessages(), input.revertMessageID())
    },
    emptyUserMessages,
    { equals: same },
  )
  const more = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.more(id) : false
  })
  const loading = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.loading(id) : false
  })
  const loadOlder = async (options?: { before?: () => void; after?: (done: boolean) => void }) => {
    return loadOlderTimeline({
      sessionID: input.sessionID,
      more,
      loading,
      loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
      before: options?.before,
      after: options?.after,
    })
  }

  onCleanup(clearRefresh)

  return {
    history: { loadOlder, loading, more },
    lastUserMessage: createMemo(() => visibleUserMessages().at(-1)),
    messages,
    ready,
    resource,
    userMessages,
    visibleUserMessages,
  }

  function clearRefresh() {
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    refreshFrame = undefined
    refreshTimer = undefined
  }
}
