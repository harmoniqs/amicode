import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { sseTickTelemetry } from "@/server/shared/sse-tick-telemetry"
import { EventV2 } from "@opencode-ai/core/event"
import { NodeHttpServerRequest } from "@effect/platform-node"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi, EventPaths } from "../groups/event"

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

// ── #1798 phase C: the bounded fan-out write path ─────────────────────────────
//
// The platform's response writer parks FOREVER on a FIN-less corpse:
// nodeResponse.write() returns false once the socket buffer is full, and the
// fiber then waits for a `drain` event the corpse never produces (the
// frontdoor recycler kills its upstreams with close() while they are blocked
// in recv — no FIN, the frontdoor's own #1757 comment). Unbounded, that park
// wedges the connection's whole recurring emission: Stream.tick and the bus
// fan-out back up behind the write, heartbeats die while HTTP stays healthy,
// the frontdoor's dead-man recycler kills MORE upstreams, and the loop
// propagates fleet-wide. Bound it instead: emission hands every chunk to a
// small bounded per-connection queue with an offer timeout. When the offer
// times out, the subscriber is a corpse — drop it (registry unregister + one
// SSE-DROP telemetry line + engine-side socket close) and keep emitting to
// every other subscriber. A dead subscriber wedges NOTHING.
const WRITE_QUEUE_CAPACITY = 64
// The writer's end-of-stream sentinel handed through the write queue: a
// zero-length chunk is never a real SSE frame.
const END_OF_STREAM = new Uint8Array(0)

class WriteStallError {
  readonly _tag = "WriteStallError"
}

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
    // #1798 phase A: this connection's tick telemetry identity. The registry
    // is eager (like the listener above) and the stream finalizer unregisters;
    // the heartbeat cadence is single-sourced from the telemetry singleton —
    // the contract in sse-tick-telemetry.ts is the one place both must agree.
    const connId = eventID()
    sseTickTelemetry.registerConnection(EventPaths.event, connId)
    const heartbeat = Stream.tick(sseTickTelemetry.cadenceMs).pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
      // One telemetry line per heartbeat: the emitting fiber's identity and
      // the emitter's queue depth ride every tick (queue depth at stall onset
      // discriminates the blocked-shared-emit-loop hypothesis), alongside the
      // watchdog's lag and RSS samples.
      Stream.tap(() =>
        Effect.gen(function* () {
          const fiberId = yield* Effect.fiberId
          sseTickTelemetry.noteTick(EventPaths.event, connId, {
            queueDepth: Queue.sizeUnsafe(queue),
            fiberId,
          })
        }),
      ),
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
    // #1798 phase C: emit through a bounded, non-blocking write path instead
    // of handing the merged stream to the platform writer (which parks
    // forever on a full corpse socket — see the WRITE_QUEUE_CAPACITY block
    // above). This connection's writer fiber encodes every frame and hands
    // each chunk to a small bounded queue; the response body is just that
    // queue, so backpressure from a dead socket can only ever fill 64 chunks
    // before the offer bound trips and the corpse is dropped.
    const serverRequest = yield* HttpServerRequest.HttpServerRequest
    const scope = yield* Effect.scope
    const writeQueue = yield* Queue.bounded<Uint8Array>(WRITE_QUEUE_CAPACITY)
    // Half a watchdog window: a stalled subscriber is dropped before its
    // silence could ever be declared a process-wide tick stall — the engine
    // heals itself instead of naming its own death.
    const writeStallMs = Math.max(1, Math.floor(sseTickTelemetry.watchdogIntervalMs / 2))
    let streamEnded = false
    let dropped = false
    const dropConnection = () =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (dropped) return
          dropped = true
          // The drop line beats the eviction: the registry forgets the corpse
          // and the telemetry names it, with the depths that show the write
          // path parked (events kept piling in, the write queue pinned full).
          sseTickTelemetry.noteDrop(EventPaths.event, connId, {
            reason: "stalled_write",
            eventQueueDepth: Queue.sizeUnsafe(queue),
            writeQueueDepth: Queue.sizeUnsafe(writeQueue),
          })
          yield* Queue.shutdown(writeQueue)
          // Tear the connection down on our side: destroy the response and
          // the socket it rides, which interrupts the parked platform writer
          // through the response 'close' handler. (Bun runtime gap, measured
          // 2026-10-14: none of res.destroy / socket.destroy /
          // socket.resetAndDestroy actually send a FIN or RST to the peer —
          // the wire-level close is the frontdoor slice's end of the
          // contract; the engine-side teardown is what unwedges the fiber and
          // frees the connection bookkeeping.)
          yield* Effect.sync(() => {
            const rawResponse = NodeHttpServerRequest.toServerResponse(serverRequest)
            // Only the platform-node server carries the raw response; other
            // platforms skip the socket close (the interrupt-only exit still
            // unwedges the fiber).
            if (typeof rawResponse?.destroy === "function") rawResponse.destroy()
            const socket = rawResponse?.socket
            if (typeof socket?.destroy === "function") socket.destroy()
          })
        }),
      )
    const offerBounded = (chunk: Uint8Array) =>
      Queue.offer(writeQueue, chunk).pipe(
        Effect.timeoutOrElse({
          duration: writeStallMs,
          orElse: () => dropConnection().pipe(Effect.andThen(Effect.fail(new WriteStallError()))),
        }),
      )
    yield* Stream.fromArray(preamble)
      .pipe(
        Stream.concat(live.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.runForEach(offerBounded),
        Effect.flatMap(() => {
          // Normal end (instance disposed): hand the sentinel through so the
          // response drains every buffered chunk and FINs cleanly.
          streamEnded = true
          return offerBounded(END_OF_STREAM)
        }),
        Effect.catchTag("WriteStallError", () => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            // Interrupt (client hangup) or unexpected failure: end the body
            // stream rather than leaving a parked consumer. The drop path has
            // already shut the queue down itself.
            if (!streamEnded && !dropped) Queue.shutdown(writeQueue)
          }),
        ),
        Effect.forkIn(scope),
      )
    return HttpServerResponse.stream(
      Stream.fromQueue(writeQueue).pipe(
        Stream.takeUntil((chunk) => chunk.length === 0),
        Stream.ensuring(
          Effect.gen(function* () {
            yield* Effect.logInfo("event disconnected")
            yield* Effect.sync(() => sseTickTelemetry.unregisterConnection(connId))
          }),
        ),
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
