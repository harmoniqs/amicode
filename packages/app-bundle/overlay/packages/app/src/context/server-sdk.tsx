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
import { postClientLog } from "@/amicode/client-telemetry"
import { ServerScope } from "@/utils/server-scope"
import { attachOwnerHeaderIfArmed } from "@/components/remote-create-arm"
import { parseCursorNamespaces, resolveEventOrigin } from "./sse-origin"
import { shouldReconnectIdleStream } from "./stream-liveness"
import { detectServerProtocol, type ServerProtocol } from "@/utils/server-protocol"
import { createCompatibleApi, type CompatibleApi } from "@/utils/server-compat"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

/** Whether an ended stream attempt was closed on purpose (our own abort) —
 *  the reconnect loop's classifier: a closed stream reconnects silently,
 *  a real failure marks the status and latches the error log. */
export const isStreamClosed = (error: unknown, signal?: AbortSignal) =>
  isAbortError(error) || signal?.aborted === true
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
  // 2026-10-08: the instance /event route emits the V1 wire shape — the
  // payload rides `properties`, not `data` (the V2 shape the named cases
  // above normalize). The default case mapped `event.data` blindly, so every
  // live V1 event reached the reducers with properties: undefined — live
  // question.asked cards never rendered; every card the panel ever showed
  // came from the /question list fetch on session open or reload.
  return { id: event.id, type: event.type, properties: event.data ?? event.properties, current: event } as ServerEvent
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

// #1751 — the dead-man's switch. The servers the panel streams from heartbeat
// on a cadence: the frontdoor's merged /api/event pool frames every ~15s (the
// live evidence behind the issue), and the instance route's own SSE heartbeat
// ticks even faster (10s), so a healthy stream never goes a few cadences
// without a frame. An abruptly-dead host (process kill, rolling deploy, network
// partition) produces no clean close and no error — the reader sits parked
// inside `for await` and the panel freezes "thinking" (17:22:50: the frontdoor
// died mid-turn and ZERO reconnect attempts followed for 12 minutes, while a
// clean-close reconnect worked a minute earlier). The switch converts every
// abrupt-death mode into a self-heal: 3 missed cadences — one is noise, three
// in a row is a dead stream. A misfire costs one reconnect, which the
// lastEventID replay (#1264) makes cheap. Threshold derivation: 3 × 15s = 45s.
export const HEARTBEAT_CADENCE_MS = 15_000
export const DEAD_MAN_MISSES = 3
export const DEFAULT_DEAD_MAN_THRESHOLD_MS = HEARTBEAT_CADENCE_MS * DEAD_MAN_MISSES

/** The threshold seam (#1751): 3 × the heartbeat cadence by default,
 *  overridable via AMICODE_SSE_DEADMAN_MS (milliseconds). An unusable
 *  override degrades to the derived default — it can never disable the
 *  switch. */
export function deadManThresholdMs(
  env: { AMICODE_SSE_DEADMAN_MS?: string | undefined } | undefined =
    typeof globalThis.process !== "undefined"
      ? (globalThis.process.env as { AMICODE_SSE_DEADMAN_MS?: string | undefined })
      : undefined,
): number {
  const parsed = Number(env?.AMICODE_SSE_DEADMAN_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEAD_MAN_THRESHOLD_MS
}

/** The reader's own liveness clock — the connection owns its liveness. `open`
 *  arms it once the stream is nominally open; `frame` re-arms it on every
 *  received frame (never blocks, never busy-waits — it only observes frames
 *  as they arrive); `close` disarms it when the stream ends for any reason.
 *  When no frame arrives within the threshold while armed, `onDead` fires
 *  exactly once per silent window. */
export function createDeadMansSwitch(onDead: () => void, thresholdMs = deadManThresholdMs()) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    timer = undefined
    onDead()
  }
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(fire, thresholdMs)
  }
  return {
    open: arm,
    frame: arm,
    close: () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
/** #1760 P4 (4b) — the telemetry-visible assert: the global SDK event
 *  stream's URL, posted to the serving origin's #1748 client log
 *  (`/__amicode_client_log`) so the hub-host client posture is provable in
 *  production, not just in tests — the headless probe greps the hub's
 *  client-errors.log for this line and asserts it equals the hub URL (the
 *  live failure it kills: a panel whose global stream pointed at a private
 *  bus, invisible until this line existed). The channel is fire-and-forget
 *  (postClientLog's contract), so a non-amicode serving origin 404s it
 *  silently — harmless everywhere, decisive on the hub. */
export function postEventStreamUrlAssert(url: string, post: (body: string) => void = postClientLog) {
  post(`{"assert":"global-sdk-event-url","url":${JSON.stringify(url)}}`)
}

/** Compose the outgoing request headers for the owner-header PRODUCER seam.
 *
 * The bug this fixes (#1643 follow-up): createOpencodeClient applies the Basic
 * credential as the CLIENT's base headers, NOT per-request `init.headers`. The
 * fetch wrapper rebuilds `init.headers` when it arms the owner header, which
 * SHADOWS the client base headers — so the armed create went out with no
 * Authorization and 401'd, while every other (un-rewritten) call kept the base
 * credential. Seeding the base Authorization here before arming keeps it on the
 * rewritten request. Returns the same reference when nothing was armed (the
 * wrapper leaves `init` untouched → base headers still apply). */
export function composeArmedRequestHeaders(input: {
  method: string
  url: string
  initHeaders: HeadersInit | undefined
  baseAuthorization: string | undefined
  attach: (method: string, url: string, headers: Record<string, string>) => Record<string, string>
}): { rewritten: boolean; headers: Record<string, string> } {
  const seeded: Record<string, string> = {}
  if (input.baseAuthorization) seeded["authorization"] = input.baseAuthorization
  new Headers(input.initHeaders).forEach((v, k) => (seeded[k] = v))
  // Snapshot to detect whether `attach` changed anything (it returns the SAME
  // reference when not armed). We compare against a copy because we mutated
  // `seeded` above with the base auth.
  const before = { ...seeded }
  const after = input.attach(input.method, input.url, seeded)
  const rewritten = after !== seeded || JSON.stringify(after) !== JSON.stringify(before)
  return { rewritten, headers: after }
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
  // 2026-10-18: burst-aware flush. A reconnect replay delivers the whole gap
  // as a burst; 16ms flushes fire BETWEEN frames producing many re-renders
  // (the visible reattachment shaking). When the queue is deep (>4 items),
  // widen the flush to 80ms so the burst lands in ONE flush = one re-render.
  const BURST_FLUSH_FRAME_MS = 80

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
    const frameMs = queue.length > 4 ? BURST_FLUSH_FRAME_MS : FLUSH_FRAME_MS
    const elapsed = Date.now() - last
    timer = setTimeout(flush, Math.max(0, frameMs - elapsed))
  }

  let streamErrorLogged = false
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  let attempt: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  // Amicode webview: connection visibility for the ConnectionBanner. The loop
  // below reconnects silently every RECONNECT_DELAY_MS, so without a signal a
  // dead server reads as an endless "thinking" wave. Liveness itself rides the
  // dead-man's switch below (#1751) — the earlier claim here that upstream's
  // bounded SSE heartbeat "already governs liveness" was disproven live
  // (17:22:50: an abruptly-dead host sends no clean close, so the reader parks
  // in for-await and nothing fires; zero reconnects for 12 minutes).
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
    // #1760 P4 (4b): ship the assert BEFORE the first attempt — the stream's
    // URL is the fact the probe verifies, and it must reach the log even if
    // the stream itself never connects (a dead door is exactly when the line
    // matters most).
    postEventStreamUrlAssert(server.http.url)
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
        // #1751 dead-man's switch: the attempt's own liveness clock. Fired
        // (disconnect + abort) when the armed window lapses with no frame —
        // the abort ends the parked reader, which brings the loop round for a
        // reconnect with the lastEventID cursor exactly like a clean close.
        const deadMan = createDeadMansSwitch(() => {
          setStreamStatus("disconnected")
          attempt?.abort()
        })
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
          // 2026-10-18: bump the resync signal on EVERY connection (re)establishment.
          // Session views tracking forceResync re-render when this changes. Without
          // it, a normal disconnect→reconnect cycle leaves older views' reactive
          // bindings stale (the newest view re-renders because its graph was just
          // created; the older ones never get the edge). One bump per connect = one
          // re-render pass across all views, batched by the burst-aware flush.
          setResyncCount((n) => n + 1)
          deadMan.open()
          lastFrameAt = Date.now()
          let yielded = Date.now()
          for await (const event of events) {
            // A buffered frame can arrive after AbortController.abort(). The
            // reset invalidates first, so it cannot restore a stale cursor or
            // mutate the new effective stream's session state.
            if (!streamGeneration.accepts(active)) return
            deadMan.frame()
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
          deadMan.close()
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
      // 2026-10-21: only force-reconnect a STALE connected stream. A flapping
      // network interface fires "online" every few seconds (wifi on the edge),
      // and the unconditional reconnect shot every healthy stream on each flap
      // — the 0.0s death loop: connect → flap → abort → reconnect → flap → ...
      // The stream never stabilized and the composer refused every send during
      // the perpetual gap. A healthy stream (fresh frames) now survives flaps;
      // a genuinely dead socket goes stale and the watchdog reconnects it.
      if (
        streamStatus() === "connected" &&
        Date.now() - lastFrameAt > WAKE_STALE_MS
      )
        forceReconnect()
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
      const baseAuthorization =
        server.http.password !== undefined
          ? `Basic ${btoa(`${server.http.username ?? "opencode"}:${server.http.password}`)}`
          : undefined
      const composed = composeArmedRequestHeaders({
        method,
        url,
        initHeaders: init?.headers,
        baseAuthorization,
        attach: attachOwnerHeaderIfArmed,
      })
      // Only rewrite when the owner header was actually attached (an armed
      // create). Unarmed calls leave `init` untouched so the client's base
      // headers still apply byte-identically to before.
      if (composed.rewritten) headerInit = { ...init, headers: composed.headers }
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
