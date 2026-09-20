import type { Message, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, createResource, onCleanup, untrack, type Accessor } from "solid-js"
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
}) {
  const serverSync = useServerSync()
  const sync = useSync()
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined

  const [resource] = createResource(
    () => input.sessionID(),
    async (id) => {
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
      const cached = untrack(() => sync().data.message[id] !== undefined)
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
      if (untrack(() => sync().data.message[id] !== undefined)) {
        void sync().session.sync(id).catch(() => {})
        return
      }
      return sync().session.sync(id)
    },
  )
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
