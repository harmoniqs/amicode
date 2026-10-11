import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

type SsePayload = { id: string; type: string; properties: unknown }

// SSE reconnects are silent: EventSource retries automatically, heartbeats keep
// the stream looking alive, and every event published during the disconnect is
// lost forever — tabs wedge mid-turn ("thinking" with no updates) until a
// manual reload. The client already carries a cursor (#1264: sessionStorage
// `lastEventID` query param; browser EventSource does the same via the
// Last-Event-ID header once the server emits SSE ids). This side of the
// contract: tag every SSE event with its id, keep a bounded process-wide ring
// of recent payloads, and replay the gap on reconnect. When the cursor
// predates the ring's retention (or a fresh process cannot cover it at all),
// emit a `state.resync` sentinel instead — clients should refetch fully.
const RING_CAPACITY = 8192
const RING_BYTE_BUDGET = 48 * 1024 * 1024

interface RingEntry extends SsePayload {
  readonly directory: string | undefined
  readonly workspaceID: string | undefined
  readonly size: number
}

const ring: Array<RingEntry> = []
let ringBytes = 0
let ringEvictedThrough: string | undefined

const ringAppend = (event: EventV2.Payload): Effect.Effect<void> =>
  Effect.sync(() => {
    const last = ring[ring.length - 1]
    if (last !== undefined && last.id === event.id) return
    const data = JSON.stringify(event.data)
    const size = event.id.length + event.type.length + data.length
    ringBytes += size
    ring.push({
      id: event.id,
      type: event.type,
      properties: event.data,
      directory: event.location?.directory,
      workspaceID: event.location?.workspaceID,
      size,
    })
    while (ring.length > RING_CAPACITY || (ring.length > 0 && ringBytes > RING_BYTE_BUDGET)) {
      const evicted = ring.shift()
      if (evicted === undefined) break
      ringBytes -= evicted.size
      ringEvictedThrough = evicted.id
    }
  })

function eventData(data: SsePayload): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: data.id,
    data: JSON.stringify(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

function cursorFromRequest(request: HttpServerRequest.HttpServerRequest): string | undefined {
  try {
    const url = new URL(request.url, "http://localhost")
    const query = url.searchParams.get("lastEventID")
    if (query !== null) return query
  } catch {
    /* fall through to the standard header */
  }
  return request.headers["last-event-id"] ?? undefined
}

function eventResponse(events: EventV2.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    const cursor = cursorFromRequest(yield* HttpServerRequest.HttpServerRequest)
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    const queue = yield* Queue.unbounded<EventV2.Payload>()
    const unsubscribe = yield* events.listen((event) => Effect.sync(() => Queue.offerUnsafe(queue, event)))
    yield* Effect.addFinalizer(() => unsubscribe)
    const stream = Stream.fromQueue(queue).pipe(
      Stream.filter(
        (event) =>
          event.location?.directory === instance.directory &&
          (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID),
      ),
      Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data })),
    )
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>((queue) => {
      const listener = (event: {
        directory?: string
        payload: { id?: string; type?: string; properties?: unknown }
      }) => {
        if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
        Queue.offerUnsafe(queue, {
          id: event.payload.id ?? eventID(),
          type: "server.instance.disposed",
          properties: event.payload.properties ?? {},
        })
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
    })
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    const replay = new Array<SsePayload>()
    let resync = false
    if (cursor !== undefined) {
      const oldest = ring[0]
      if (
        oldest === undefined ||
        cursor < oldest.id ||
        (ringEvictedThrough !== undefined && cursor <= ringEvictedThrough)
      ) {
        resync = true
      } else {
        for (const entry of ring) {
          if (entry.id <= cursor) continue
          if (entry.directory !== instance.directory) continue
          if (entry.workspaceID !== undefined && entry.workspaceID !== workspaceID) continue
          replay.push(entry)
        }
      }
    }
    const replayedIds = new Set(replay.map((event) => event.id))
    const replayWatermark = replay.length > 0 ? replay[replay.length - 1]!.id : undefined
    const live = output.pipe(
      Stream.filter(
        (event) =>
          !replayedIds.has(event.id) && (replayWatermark === undefined || event.id > replayWatermark),
      ),
    )
    const preamble: Array<SsePayload> = [
      { id: eventID(), type: "server.connected", properties: {} },
      ...(resync
        ? [{ id: eventID(), type: "state.resync", properties: { reason: "retention" } satisfies unknown }]
        : []),
      ...replay,
    ]

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.fromArray(preamble).pipe(
        Stream.concat(live.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    yield* events.listen(ringAppend)
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
