import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { dispatchSseFocusEvent } from "../pages/new-session/new-session-machine-mount"
import { isSyncGapType, parseSyncGapFrame, SYNC_GAP_TYPE } from "./sse-gap-frame"
import { type Accessor, batch, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { createApiForServer, createSdkForServer, type ServerApi } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerScope } from "@/utils/server-scope"
import { attachOwnerHeaderIfArmed } from "@/components/remote-create-arm"
import { parseCursorNamespaces, resolveEventOrigin } from "./sse-origin"
import { shouldReconnectIdleStream } from "./stream-liveness"
import { detectServerProtocol, type ServerProtocol } from "@/utils/server-protocol"
import { createCompatibleApi, type CompatibleApi } from "@/utils/server-compat"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

const isStreamClosed = (error: unknown, signal?: AbortSignal) => isAbortError(error) || signal?.aborted === true
export type ServerEvent = Event & { current?: OpenCodeEvent; origin?: string }
type QueuedServerEvent = { directory: string; payload: ServerEvent }
/** A minimal fetch call signature. Newer lib types make `typeof fetch` require
 *  a `preconnect` member our plain wrappers don't implement (lib drift);
 *  consumers that insist on `typeof fetch` cast at the call site. */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type CurrentDelta = Extract<
  OpenCodeEvent,
  { type: "session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta" | "session.compaction.delta" }
>

export function adaptServerEvent(event: OpenCodeEvent): ServerEvent {
  if (event.type === "permission.v2.asked") {
    return {
      id: event.id,
      type: "permission.asked",
      properties: {
        id: event.data.id,
        sessionID: event.data.sessionID,
        permission: event.data.action,
        patterns: event.data.resources,
        always: event.data.save ?? [],
        metadata: event.data.metadata ?? {},
        tool:
          event.data.source?.type === "tool"
            ? { messageID: event.data.source.messageID, callID: event.data.source.callID }
            : undefined,
      },
      current: event,
    } as ServerEvent
  }
  if (event.type === "permission.v2.replied")
    return { id: event.id, type: "permission.replied", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.asked")
    return { id: event.id, type: "question.asked", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.replied")
    return { id: event.id, type: "question.replied", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.rejected")
    return { id: event.id, type: "question.rejected", properties: event.data, current: event } as ServerEvent
  return { id: event.id, type: event.type, properties: event.data, current: event } as ServerEvent
}

const coalescedKey = (event: QueuedServerEvent) => {
  if (event.payload.type === "lsp.updated") return `lsp.updated:${event.directory}`
  if (event.payload.type === "message.part.updated") {
    const part = event.payload.properties.part
    return `message.part.updated:${event.directory}:${part.messageID}:${part.id}`
  }
  return undefined
}

export function enqueueServerEvent(queue: QueuedServerEvent[], event: QueuedServerEvent) {
  const key = coalescedKey(event)
  const previous = queue[queue.length - 1]
  if (key && previous && coalescedKey(previous) === key) {
    queue[queue.length - 1] = event
    return false
  }
  queue.push(event)
  return true
}

export function coalesceServerEvents(events: QueuedServerEvent[]) {
  const output: QueuedServerEvent[] = []
  events.forEach((event) => {
    const current = currentDelta(event.payload.current)
    if (current) {
      const previous = output[output.length - 1]
      const prior = currentDelta(previous?.payload.current)
      if (
        previous &&
        prior &&
        previous.directory === event.directory &&
        currentDeltaKey(prior) === currentDeltaKey(current)
      ) {
        const fragment = currentDeltaFragment(prior) + currentDeltaFragment(current)
        const data =
          current.type === "session.compaction.delta"
            ? { ...current.data, text: fragment }
            : { ...current.data, delta: fragment }
        output[output.length - 1] = {
          directory: event.directory,
          payload: {
            ...event.payload,
            properties: data,
            current: { ...current, data } as CurrentDelta,
          } as ServerEvent,
        }
        return
      }
      output.push(event)
      return
    }
    if (event.payload.type !== "message.part.delta") {
      output.push(event)
      return
    }
    const props = event.payload.properties
    const previous = output[output.length - 1]
    if (
      !previous ||
      previous.payload.type !== "message.part.delta" ||
      previous.directory !== event.directory ||
      previous.payload.properties.messageID !== props.messageID ||
      previous.payload.properties.partID !== props.partID ||
      previous.payload.properties.field !== props.field
    ) {
      output.push({
        directory: event.directory,
        payload: { ...event.payload, properties: { ...props } },
      })
      return
    }
    output[output.length - 1] = {
      directory: event.directory,
      payload: {
        ...event.payload,
        properties: { ...props, delta: previous.payload.properties.delta + props.delta },
      },
    }
  })
  return output
}

function currentDelta(event: OpenCodeEvent | undefined): CurrentDelta | undefined {
  if (
    event?.type === "session.text.delta" ||
    event?.type === "session.reasoning.delta" ||
    event?.type === "session.tool.input.delta" ||
    event?.type === "session.compaction.delta"
  )
    return event
}

function currentDeltaKey(event: CurrentDelta) {
  if (event.type === "session.tool.input.delta")
    return `${event.type}:${event.data.sessionID}:${event.data.assistantMessageID}:${event.data.callID}`
  if (event.type === "session.compaction.delta") return `${event.type}:${event.data.sessionID}`
  return `${event.type}:${event.data.sessionID}:${event.data.assistantMessageID}:${event.data.ordinal}`
}

function currentDeltaFragment(event: CurrentDelta) {
  return event.type === "session.compaction.delta" ? event.data.text : event.data.delta
}

export function resumeStreamAfterPageShow(_event: PageTransitionEvent, start: () => unknown) {
  start()
}

type EffectiveStreamIdentity = { machine_id: string; sshAlias: string; transport: string }
type ParsedEffectiveStreamSignal =
  | { mode: "local"; identity: null }
  | { mode: "legacy-single-pointer"; identity: EffectiveStreamIdentity }
  | { mode: "multiplexed"; identity: null }

function effectiveStreamIdentity(value: unknown): EffectiveStreamIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const machine_id = typeof input.machine_id === "string" ? input.machine_id.trim() : ""
  const sshAlias = typeof input.sshAlias === "string" ? input.sshAlias.trim() : ""
  const transport = typeof input.transport === "string" ? input.transport.trim() : ""
  if (!machine_id || !sshAlias || !transport) return undefined
  return { machine_id, sshAlias, transport }
}

function parseEffectiveStreamSignal(value: unknown): ParsedEffectiveStreamSignal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.ok !== true || typeof input.mode !== "string") return undefined
  if (input.mode === "local" && input.identity === null) return { mode: "local", identity: null }
  if (input.mode === "multiplexed" && input.identity === null) return { mode: "multiplexed", identity: null }
  if (input.mode === "legacy-single-pointer") {
    const identity = effectiveStreamIdentity(input.identity)
    if (identity) return { mode: "legacy-single-pointer", identity }
  }
  return undefined
}

function parsedSuccessfulControl(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as { ok?: unknown }).ok === true
}

function sameEffectiveStreamIdentity(a: EffectiveStreamIdentity | null, b: EffectiveStreamIdentity | null): boolean {
  if (a === null || b === null) return a === b
  return a.machine_id === b.machine_id && a.sshAlias === b.sshAlias && a.transport === b.transport
}

/** Whether one attachment control may invalidate the legacy global stream.
 * The local effective-stream endpoint is authoritative only for its legacy
 * compatibility mode; Fleet v2 multiplexing owns the per-peer data plane and
 * must not be reset from an attachment-pointer observation. */
export function globalStreamResetRequired(input: { control: unknown; before: unknown; after: unknown }): boolean {
  if (!parsedSuccessfulControl(input.control)) return false
  const before = parseEffectiveStreamSignal(input.before)
  const after = parseEffectiveStreamSignal(input.after)
  if (!before || !after || before.mode === "multiplexed" || after.mode === "multiplexed") return false
  const beforeIdentity = before.mode === "legacy-single-pointer" ? before.identity : null
  const afterIdentity = after.mode === "legacy-single-pointer" ? after.identity : null
  return !sameEffectiveStreamIdentity(beforeIdentity, afterIdentity)
}

/** A serialized, generation-fenced reset for the compatibility global stream.
 * Invalidating the generation precedes the old request's abort, so a late
 * frame has no authority to restore the cursor or mutate session state. */
export function createGlobalStreamResetCoordinator(input: {
  abort: () => void
  clearCursor: () => void
  waitForOldStream: () => Promise<void>
  reconnect: () => void
}) {
  let generation = 0
  let serial = Promise.resolve()

  const resetAfterControl = (change: { control: unknown; before: unknown; after: unknown }): Promise<boolean> => {
    if (!globalStreamResetRequired(change)) return Promise.resolve(false)
    const requestedGeneration = ++generation
    const task = serial.then(async () => {
      // A second valid transition supersedes a reset still waiting to reconnect.
      if (requestedGeneration !== generation) return false
      input.abort()
      input.clearCursor()
      await input.waitForOldStream()
      if (requestedGeneration !== generation) return false
      input.reconnect()
      return true
    })
    serial = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  return {
    current: () => generation,
    accepts: (candidate: number) => candidate === generation,
    invalidate: () => ++generation,
    resetAfterControl,
  }
}

/** What an SSE stream error must do, extracted so the ABORT — the part that
 *  reads as redundant and is easy to delete — is covered by a test.
 *
 *  The v1 event stream reports failures through its `onSseError` callback and
 *  then simply stops yielding: the async iterator neither throws nor completes.
 *  The reconnect loop only comes round when that iterator ends, so without the
 *  abort it parks inside `for await` forever and the client stays disconnected
 *  from a server that is already back — opencode#132's stuck banner, and every
 *  solver switch since #221, which restarts the server by design.
 *
 *  Returns whether this was a real failure, so the caller keeps its log latch. */
export function applySseError(input: { closed: boolean; disconnect: () => void; abort: () => void }): boolean {
  if (input.closed) return false
  input.disconnect()
  input.abort()
  return true
}

type ServerEventEmitter = ReturnType<typeof createGlobalEmitter<{ [key: string]: ServerEvent }>>
type ServerSDKBase = {
  server: ServerConnection.Any
  scope: ServerScope
  protocol: Promise<ServerProtocol>
  protocolKind: Accessor<ServerProtocol | undefined>
  url: string
  client: ReturnType<typeof createSdkForServer>
  api: CompatibleApi
  currentApi: ServerApi
  event: {
    on: ServerEventEmitter["on"]
    listen: ServerEventEmitter["listen"]
    start: () => Promise<void> | undefined
    /** amicode webview: live stream visibility for the ConnectionBanner —
     *  "connected" only while the SSE loop is actively subscribed. */
    status: Accessor<"connected" | "disconnected">
    /** #1617: a monotonic counter bumped each time a `amicode.sync.gap` frame is
     *  intercepted (the fan-in overflow signal). Surfaces to the entity rail as
     *  the forced-resync signal so a WEDGE — which never crosses the
     *  disconnect→connect edge — still heals the rail. */
    resyncCount: Accessor<number>
    /** Reset only the legacy single-pointer global stream after a successful
     * attachment control changes the local effective data-plane identity. */
    resetForAttachmentChange: (input: { control: unknown; before: unknown; after: unknown }) => Promise<boolean>
  }
  createClient: (
    opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">,
  ) => ReturnType<typeof createSdkForServer>
}

function createServerSdkContextBase(server: ServerConnection.Any, scope: ServerScope): ServerSDKBase {
  const platform = usePlatform()
  const abort = new AbortController()

  const eventFetch = (() => {
    if (!platform.fetch || !server) return
    try {
      const url = new URL(server.http.url)
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
      if (url.protocol === "http:" && !loopback) return platform.fetch
    } catch {
      return
    }
  })()

  // #1264 lossless reconnect: the frontdoor buffers recent events and
  // replays the gap when the stream is re-opened with ?lastEventID=<id>.
  // Track the last payload id seen (the server ids every event; id-less
  // events just don't advance the cursor — replay may over-deliver, which
  // the reconcile-based reducers tolerate by design).
  // #1264: the cursor must survive RELOADS — module state died with every
  // document, so a drop right after a reload reconnected cursor-less and
  // the gap's events were lost (the harness caught it: the sse-gap flow
  // failed only in the post-reload context). sessionStorage is per-tab,
  // cheap, and exactly the lifetime the cursor wants.
  const CURSOR_KEY = "amicode.sse.lastEventID"
  let lastEventID: string | undefined
  try {
    lastEventID = sessionStorage.getItem(CURSOR_KEY) ?? undefined
  } catch {
    /* private mode etc. — degrade to module state */
  }
  const trackEventID = (payload: unknown) => {
    const id = (payload as { id?: unknown } | undefined)?.id
    if (typeof id === "string" && id) {
      lastEventID = id
      try {
        sessionStorage.setItem(CURSOR_KEY, id)
      } catch {
        /* best-effort */
      }
    }
  }
  // #1539: track the parsed composite cursor to detect event origin (local vs
  // remote peer). Initialized from the persisted cursor so the first event
  // after reconnect diffs correctly.
  let previousParsedCursor = parseCursorNamespaces(lastEventID)
  const sseFetch: FetchLike = (input, init) => {
    const base = eventFetch ?? globalThis.fetch
    try {
      if (lastEventID) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        const u = new URL(url, server.http.url)
        if (u.pathname === "/event" || u.pathname === "/global/event") {
          u.searchParams.set("lastEventID", lastEventID)
          const modified = u.toString()
          if (typeof input === "string" || input instanceof URL) return base(modified, init)
          return base(new Request(modified, input), init)
        }
      }
    } catch {
      /* fall through unmodified */
    }
    return base(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1])
  }
  const eventApi = createApiForServer({ server: server.http, fetch: sseFetch as typeof fetch })
  const eventSdk = createSdkForServer({
    signal: abort.signal,
    fetch: sseFetch as typeof fetch,
    server: server.http,
  })
  const protocol = detectServerProtocol(server.http, platform.fetch ?? globalThis.fetch)
  const [protocolKind] = createResource(
    () => protocol,
    (value) => value,
  )
  const emitter = createGlobalEmitter<{
    [key: string]: ServerEvent
  }>()

  type Queued = QueuedServerEvent
  const FLUSH_FRAME_MS = 16
  const STREAM_YIELD_MS = 8
  const RECONNECT_DELAY_MS = 250

  let queue: Queued[] = []
  let buffer: Queued[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined

    if (queue.length === 0) return

    const events = queue
    queue = buffer
    buffer = events
    queue.length = 0

    last = Date.now()
    const output = coalesceServerEvents(events)
    batch(() => {
      output.forEach((event) => emitter.emit(event.directory, event.payload))
    })

    buffer.length = 0
  }

  const schedule = () => {
    if (timer) return
    const elapsed = Date.now() - last
    timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
  }

  let streamErrorLogged = false
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  let attempt: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  // Amicode webview: connection visibility for the ConnectionBanner. The loop
  // below reconnects silently every RECONNECT_DELAY_MS, so without a signal a
  // dead server reads as an endless "thinking" wave. (The branch's 15s
  // heartbeat timer is NOT carried — upstream's bounded SSE heartbeat already
  // governs liveness; two abort clocks would fight.)
  const [streamStatus, setStreamStatus] = createSignal<"connected" | "disconnected">("disconnected")

  // #1617: bumped each time a `amicode.sync.gap` frame is intercepted below. The
  // entity rail reads this as its forced-resync signal (a WEDGE keeps the socket
  // nominally connected, so the disconnect→connect edge never fires and the rail
  // would otherwise never self-heal a stranded view).
  const [resyncCount, setResyncCount] = createSignal(0)

  // #1584 client-side liveness watchdog. The v1 event iterator neither throws
  // nor completes when the socket goes silently half-open (sleep/wake, Wi-Fi
  // blip, an engine replaced without FIN/RST), so `onSseError` never fires and
  // the `for await` parks forever while `streamStatus` stays "connected". We
  // track the last frame time and, on a 5s tick, force-reconnect a stream that
  // BELIEVES it is connected but has seen nothing for 30s — abort only the
  // per-attempt controller so the loop re-opens with the `lastEventID` cursor
  // (lossless); the same generation reconnects. An intentional abort is treated
  // as "closed" by the catch at ~L526, so the banner does NOT flip to
  // disconnected. Mirrors the extension-host `sse_liveness.ts` (30s/5s).
  const STREAM_STALE_MS = 30_000
  const WATCHDOG_TICK_MS = 5_000
  // A tab returning to visible / the network coming back are the signals that
  // actually fire in a VS Code webview under retainContextWhenHidden, where
  // pageshow/pagehide do NOT fire on a tab switch — re-arm with a tighter
  // window so a wake reconnects promptly.
  const WAKE_STALE_MS = 10_000
  let lastFrameAt = Date.now()
  let watchdog: ReturnType<typeof setInterval> | undefined
  // Reset the frame clock and abort the parked attempt so the loop re-opens
  // (same generation, cursor intact). Shared by the watchdog and both wake
  // handlers; a no-op if the stream is already down (attempt undefined).
  const forceReconnect = () => {
    lastFrameAt = Date.now()
    // #1637: a silent-socket / watchdog forced reconnect must bump the resync
    // token so the entity rail self-heals a stranded view — a WEDGE keeps the
    // socket nominally connected, so the disconnect→connect edge never fires and
    // the rail would otherwise never re-fetch. Bump only when we actually abort a
    // parked attempt (a real forced resync), not on the already-down no-op.
    if (attempt) {
      attempt.abort()
      setResyncCount((n) => n + 1)
    }
  }

  const start = () => {
    if (started) return run
    started = true
    const active = streamGeneration.current()
    const previous = run
    const current = (async () => {
      if (previous) await previous
      // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
      while (!abort.signal.aborted && started && streamGeneration.accepts(active)) {
        const currentAttempt = new AbortController()
        attempt = currentAttempt
        const onAbort = () => {
          currentAttempt.abort()
        }
        abort.signal.addEventListener("abort", onAbort)
        try {
          const kind = await protocol
          if (!streamGeneration.accepts(active)) return
          const onSseError = (error: unknown) => {
            if (!streamGeneration.accepts(active)) return
            const real = applySseError({
              closed: isStreamClosed(error, currentAttempt.signal),
              disconnect: () => setStreamStatus("disconnected"),
              abort: () => currentAttempt.abort(),
            })
            if (!real) return
            if (streamErrorLogged) return
            streamErrorLogged = true
            console.error("[global-sdk] event stream error", {
              url: server.http.url,
              fetch: eventFetch ? "platform" : "webview",
              error,
            })
          }
          const events =
            kind === "v1"
              ? (await eventSdk.global.event({ signal: currentAttempt.signal, onSseError })).stream
              : eventApi.event.subscribe({ signal: currentAttempt.signal })
          if (!streamGeneration.accepts(active)) return
          setStreamStatus("connected")
          lastFrameAt = Date.now()
          let yielded = Date.now()
          for await (const event of events) {
            // A buffered frame can arrive after AbortController.abort(). The
            // reset invalidates first, so it cannot restore a stale cursor or
            // mutate the new effective stream's session state.
            if (!streamGeneration.accepts(active)) return
            streamErrorLogged = false
            lastFrameAt = Date.now()
            const legacy = "payload" in event
            if (legacy && event.payload.type === "sync") continue
            const directory = legacy ? (event.directory ?? "global") : (event.location?.directory ?? "global")
            const payload = legacy ? (event.payload as Event) : adaptServerEvent(event)
            // #1522 (ADR 0033 decision A): the SSE fan-in aggregator emits
            // `amicode.fleet.focus` as the first frame on (re)connect. Intercept
            // it here and dispatch to the existing picker focus latch via
            // window.postMessage — a SECOND input to the same seed path (the
            // chat_bridge push is the first). Skip the normal event queue: the
            // focus frame is not a session event.
            const focusType = legacy ? (payload as { type?: string }).type : payload.type
            if (focusType === "amicode.fleet.focus") {
              if (typeof window !== "undefined") {
                // The SSE data payload carries the focus fields directly; for the
                // adapted (non-legacy) path, the data sits in `properties`.
                const focusData = legacy
                  ? (payload as Record<string, unknown>)
                  : ((payload as { properties?: Record<string, unknown> }).properties ?? {})
                dispatchSseFocusEvent(
                  { type: "amicode.fleet.focus", ...focusData } as { type: string; focusedMachineId?: string; [k: string]: unknown },
                  window,
                )
              }
              continue
            }
            // #1617 (ADR 0033 Amendment 1): the fan-in aggregator emits an id-less
            // `amicode.sync.gap` frame when a bounded per-namespace buffer
            // overflow-dropped frames while the downstream was backpressured. A gap
            // is a real loss the reconnect-storm debounce (#1289) must NOT swallow,
            // so we drive a FORCED bootstrap refetch. Modeled on the focus-frame
            // interception directly above: the gap frame is `payload`-less bare
            // JSON, so it rides the non-legacy adapter path (`payload.type`), and
            // its data sits in `properties`. Re-emit it as a synthetic GLOBAL event
            // into the normal queue; server-sync's listener refetches the bootstrap
            // unconditionally on this type (past the #1289 `server.connected`
            // debounce, which keys on a different type). Skip the rest of the loop:
            // the gap frame is not a session event and never advances the cursor.
            if (isSyncGapType(focusType)) {
              const gapData = legacy
                ? (payload as Record<string, unknown>)
                : ((payload as { properties?: Record<string, unknown> }).properties ?? {})
              const gap = parseSyncGapFrame({ type: SYNC_GAP_TYPE, ...gapData })
              // Bump the forced-resync signal so the entity rail self-heals even
              // though the socket never crossed a disconnect→connect edge.
              setResyncCount((n) => n + 1)
              if (enqueueServerEvent(queue, {
                directory: "global",
                payload: { type: SYNC_GAP_TYPE, properties: { namespaces: gap?.namespaces ?? [] } } as unknown as ServerEvent,
              }))
                schedule()
              continue
            }
            trackEventID(legacy ? event.payload : (event as { id?: string }))
            // #1539: resolve origin from the composite cursor diff. Fleet-of-one
            // (bare scalar id) returns undefined immediately — zero overhead.
            const sseId: string | undefined = legacy
              ? (event.payload as { id?: string }).id
              : (event as { id?: string }).id
            const resolved = resolveEventOrigin(sseId, previousParsedCursor)
            previousParsedCursor = resolved.cursor
            const taggedPayload: ServerEvent = resolved.origin !== undefined
              ? { ...payload, origin: resolved.origin }
              : payload
            if (enqueueServerEvent(queue, { directory, payload: taggedPayload })) schedule()

            if (Date.now() - yielded < STREAM_YIELD_MS) continue
            yielded = Date.now()
            await wait(0)
          }
        } catch (error) {
          if (streamGeneration.accepts(active) && !isStreamClosed(error, currentAttempt.signal))
            setStreamStatus("disconnected")
          if (streamGeneration.accepts(active) && !isStreamClosed(error, currentAttempt.signal) && !streamErrorLogged) {
            streamErrorLogged = true
            console.error("[global-sdk] event stream failed", {
              url: server.http.url,
              fetch: eventFetch ? "platform" : "webview",
              error,
            })
          }
        } finally {
          abort.signal.removeEventListener("abort", onAbort)
          if (attempt === currentAttempt) attempt = undefined
        }

        if (abort.signal.aborted || !started || !streamGeneration.accepts(active)) return
        await wait(RECONNECT_DELAY_MS)
      }
    })().finally(() => {
      if (run !== current) return
      run = undefined
      flush()
    })
    run = current
    return run
  }

  const clearGlobalStreamCursor = () => {
    lastEventID = undefined
    previousParsedCursor = {}
    try {
      sessionStorage.removeItem(CURSOR_KEY)
    } catch {
      /* private mode etc. — memory was still cleared */
    }
    queue.length = 0
    buffer.length = 0
    if (timer) clearTimeout(timer)
    timer = undefined
    setStreamStatus("disconnected")
  }

  const streamGeneration = createGlobalStreamResetCoordinator({
    abort: () => attempt?.abort(),
    clearCursor: clearGlobalStreamCursor,
    waitForOldStream: async () => {
      const previous = run
      if (previous) await previous
    },
    reconnect: () => {
      if (abort.signal.aborted) return
      // waitForOldStream settled the active loop. Clearing this latch is what
      // makes the replacement call start(), and its fetch sees no cursor.
      started = false
      void start()
    },
  })

  const stop = () => {
    started = false
    streamGeneration.invalidate()
    attempt?.abort()
  }

  onMount(() => {
    makeEventListener(window, "pagehide", stop)
    makeEventListener(window, "pageshow", (event) => resumeStreamAfterPageShow(event, start))
    // #1584 watchdog: on a 5s tick, force-reconnect a stream that believes it
    // is connected but has been silent past the 30s staleness window. Guarded
    // on the live stream (started, not torn down) so a stopped stream is left
    // to the loop; forceReconnect resets the clock so a single tick fires once
    // per staleness episode, not every tick.
    watchdog = setInterval(() => {
      if (!started || abort.signal.aborted) return
      if (shouldReconnectIdleStream({ status: streamStatus(), now: Date.now(), lastFrameAt, staleMs: STREAM_STALE_MS }))
        forceReconnect()
    }, WATCHDOG_TICK_MS)
    // #1584 wake re-arm: pageshow/pagehide do NOT fire on a tab switch under
    // retainContextWhenHidden — visibilitychange and online are the signals
    // that actually fire. A tab returning to visible while the stream is stale
    // past the tighter wake window reconnects; the network coming back
    // reconnects any "connected" stream (its socket may be silently dead). A
    // healthy active stream (fresh lastFrameAt) is not stale, so a quick tab
    // toggle causes no reconnect.
    makeEventListener(document, "visibilitychange", () => {
      if (!started || abort.signal.aborted) return
      if (
        document.visibilityState === "visible" &&
        shouldReconnectIdleStream({ status: streamStatus(), now: Date.now(), lastFrameAt, staleMs: WAKE_STALE_MS })
      )
        forceReconnect()
    })
    makeEventListener(window, "online", () => {
      if (!started || abort.signal.aborted) return
      if (streamStatus() === "connected") forceReconnect()
    })
  })

  onCleanup(() => {
    stop()
    if (watchdog) clearInterval(watchdog)
    watchdog = undefined
    abort.abort()
    flush()
  })

  // #1290: every SDK call is a request/reply — a stalled tunnel must not
  // hang the caller forever ("the panel dies" was a view gate waiting on a
  // fetch with no timeout; over a flaky intercontinental link, hangs are a
  // weather condition). 30s is generous for high-RTT paths and far below
  // the old forever. A timed-out call rejects; the sync layer's retry
  // paths (and the frozen holds) carry the view until it lands.
  const platformFetch = platform.fetch ?? globalThis.fetch
  const fetchWithTimeout: FetchLike = (input, init) => {
    // #1643 (completes #1484 AC3): the owner-header PRODUCER seam (ADR 0031
    // §D1a leg 2). When the composer armed a remote create, attach
    // x-amicode-owner to the path-less session-create POST so the multiplexer
    // routes it to the owning peer. One-shot (disarms on attach); a local
    // create never arms, so this is byte-unchanged for the common case.
    let headerInit = init
    try {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const url = new URL(rawUrl, server.http.url).href
      const existing: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => (existing[k] = v))
      const withOwner = attachOwnerHeaderIfArmed(method, url, existing)
      if (withOwner !== existing) headerInit = { ...init, headers: withOwner }
    } catch {
      /* fall through unmodified — never let header logic break a request */
    }
    return platformFetch(input, {
      ...headerInit,
      signal: headerInit?.signal ?? AbortSignal.timeout(30_000),
    })
  }

  const sdk = createSdkForServer({
    server: server.http,
    fetch: fetchWithTimeout as typeof fetch,
    throwOnError: true,
  })
  const currentApi: ServerApi = createApiForServer({ server: server.http, fetch: fetchWithTimeout as typeof fetch })
  const legacy = (directory?: string) =>
    createSdkForServer({
      server: server.http,
      fetch: fetchWithTimeout as typeof fetch,
      throwOnError: true,
      directory,
    })
  const api = createCompatibleApi({ protocol, current: currentApi, legacy })

  return {
    server,
    scope,
    protocol,
    protocolKind,
    url: server.http.url,
    client: sdk,
    api,
    currentApi,
    event: {
      on: emitter.on.bind(emitter),
      listen: emitter.listen.bind(emitter),
      start,
      status: streamStatus,
      resyncCount,
      resetForAttachmentChange: streamGeneration.resetAfterControl,
    },
    createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
      return createSdkForServer({
        server: server.http,
        fetch: fetchWithTimeout as typeof fetch,
        ...opts,
      })
    },
  }
}

export type ServerSDK = ServerSDKBase & {
  ensureDirSdkContext: (directory: string) => ReturnType<typeof createDirSdkContext>
}

export function createServerSdkContext(server: ServerConnection.Any, scope: ServerScope): ServerSDK {
  const sdk = createServerSdkContextBase(server, scope)
  return Object.assign(sdk, {
    ensureDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
  })
}

export const { use: useServerSDK, provider: ServerSDKProvider } = createSimpleContext({
  name: "ServerSDK",
  // Returns an accessor so the resolved server can change reactively (e.g. a
  // /new-session draft retargeting its server) without re-instantiating the subtree.
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSDK>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sdk
    })
  },
})

export function useServerProtocol() {
  const serverSDK = useServerSDK()
  return createMemo(() => serverSDK().protocolKind())
}

type SDKEventMap = {
  [key in Event["type"]]: Extract<ServerEvent, { type: key }>
}

function createDirSdkContext(directory: string, serverSDK: ServerSDKBase) {
  const client = serverSDK.createClient({
    directory,
    throwOnError: true,
  })

  const emitter = createGlobalEmitter<SDKEventMap>()

  const unsub = serverSDK.event.on(directory, (event) => {
    emitter.emit(event.type, event)
  })
  onCleanup(unsub)

  return {
    scope: serverSDK.scope,
    protocol: serverSDK.protocol,
    directory,
    client,
    api: createCompatibleApi({
      protocol: serverSDK.protocol,
      current: serverSDK.currentApi,
      legacy: (next) => serverSDK.createClient({ directory: next ?? directory, throwOnError: true }),
      directory,
    }),
    event: emitter,
    get url() {
      return serverSDK.url
    },
    createClient(opts: Parameters<typeof serverSDK.createClient>[0]) {
      return serverSDK.createClient(opts)
    },
  }
}
