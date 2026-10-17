import { InstanceState } from "@/effect/instance-state"
import { GlobalEventReplay, formatID, type Frame } from "@/bus/global-replay"
import { sseTickTelemetry } from "@/server/shared/sse-tick-telemetry"
import { armSseSocketKeepalive } from "@/server/shared/tcp-keepalive"
import { NodeHttpServerRequest } from "@effect/platform-node"
import { makeBoundedSseWriter } from "@/server/shared/sse-bounded-writer"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi, EventPaths } from "../groups/event"

type SsePayload = { id: string; type: string; properties: unknown }

// One wire frame: the SSE `id` line plus the payload the client parses. The
// ported sequencing (#1806 P1a, main's #1776) puts the bus's `<epoch>:<seq>`
// on the id line; the payload keeps its `evt_` id — the client's dedup keys
// and (#1264) cursor vocabulary live there, and nothing about the data line
// changes.
type WireFrame = { id: string; payload: SsePayload }

// SSE reconnects are silent: EventSource retries automatically, heartbeats keep
// the stream looking alive, and every event published during the disconnect is
// lost forever — tabs wedge mid-turn ("thinking" with no updates) until a
// manual reload. This side of the contract, ported from main's #1776 (#1806
// P1a): the global bus stamps every frame `<epoch>:<seq>`, ONE shared replay
// buffer (byte+age bounded, env-tunable) serves cursor resumption, and an
// unservable cursor (evicted past the bound, a foreign epoch, ahead of the
// stream) gets the explicit `state.resync` sentinel instead — the client
// refetches fully, never a silent gap. The client's existing payload-id
// cursors (#1264: the last payload id it applied, query param or
// Last-Event-ID header) keep resolving against retained frames — wire
// compatible, no client change rides with the port.

function eventData(frame: WireFrame): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: frame.id,
    data: JSON.stringify(frame.payload),
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

function eventResponse() {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    const request = yield* HttpServerRequest.HttpServerRequest
    // #1810: kernel-level corpse detection — arm the subscriber socket at SSE
    // connection setup. Under this runtime the http-layer socket is bun's
    // fd-less shim: the arm degrades LOUDLY (once per process) and never
    // breaks the connection — the module's header records the measured boundary.
    armSseSocketKeepalive(NodeHttpServerRequest.toServerResponse(request)?.socket, EventPaths.event)
    const cursor = cursorFromRequest(request)
    // #1798 phase A: this connection's tick telemetry identity. The registry
    // is eager and the stream finalizer unregisters; the heartbeat cadence is
    // single-sourced from the telemetry singleton — the contract in
    // sse-tick-telemetry.ts is the one place both must agree.
    const connId = eventID()
    sseTickTelemetry.registerConnection(EventPaths.event, connId)
    // The connection's event queue: everything the shared buffer hands this
    // instance's view of the stream, in strict bus order. Registration is
    // eager, so events published after this point cannot be lost while the
    // HTTP body fiber is starting or emitting server.connected.
    const queue = yield* Queue.unbounded<WireFrame>()
    const matches = (frame: Frame) => {
      const event = frame.event
      if (event.directory !== instance.directory) return false
      if (event.workspace !== undefined && event.workspace !== workspaceID) return false
      return true
    }
    const payloadOf = (frame: Frame): SsePayload => {
      const payload = frame.event.payload as SsePayload
      return { id: payload.id, type: payload.type, properties: payload.properties }
    }
    // The shared replay buffer is the connection's live source: one buffer per
    // bus, shared by every subscriber (the global stream route and this
    // instance-filtered view alike), with the bus's pre-dispatch tap doing the
    // sequencing. An unservable cursor surfaces as `subscription.reset` below.
    const subscription = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const subscription = GlobalEventReplay.subscribe(cursor)
        subscription.start((frame) => {
          if (!matches(frame)) return
          Queue.offerUnsafe(queue, { id: frame.id, payload: payloadOf(frame) })
        })
        return subscription
      }),
      (subscription) => Effect.sync(() => subscription.close()),
    )
    const replay = subscription.replay.filter(matches).map((frame) => ({ id: frame.id, payload: payloadOf(frame) }))
    const preamble: Array<WireFrame> = [
      // Control frames never consume a sequence; their id line carries the
      // connection's current position, so ids on one connection never decrease.
      {
        id: formatID(GlobalEventReplay.epoch, subscription.position),
        payload: { id: eventID(), type: "server.connected", properties: {} },
      },
      ...(subscription.reset
        ? [
            {
              id: formatID(GlobalEventReplay.epoch, subscription.position),
              payload: {
                id: eventID(),
                type: "state.resync",
                properties: { reason: subscription.reset } satisfies unknown,
              },
            },
          ]
        : []),
      ...replay,
    ]

    yield* Effect.logInfo("event connected")
    // #1808 stall drill: AMICODE_SSE_TICK_STALL=1 parks the heartbeat tap
    // mid-fiber BEFORE its first noteTick (Effect.never — the #1798
    // blocked-shared-emit-loop shape), so the out-of-tree SELF-STALL watchdog
    // can be rehearsed against the PRODUCTION wiring: the connection stays
    // registered, the wire goes heartbeat-silent, and the watchdog's line
    // must ride the production sink (engine stderr → the runner's forward →
    // the shard log). Ops drill only — never set on a live shard.
    const tickStallDrill = process.env.AMICODE_SSE_TICK_STALL === "1"
    const heartbeat = Stream.tick(sseTickTelemetry.cadenceMs).pipe(
      Stream.drop(1),
      Stream.tap(() => (tickStallDrill ? Effect.never : Effect.void)),
      Stream.map(() => ({
        id: formatID(GlobalEventReplay.epoch, GlobalEventReplay.current),
        payload: { id: eventID(), type: "server.heartbeat", properties: {} },
      })),
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

    const live = Stream.fromQueue(queue).pipe(
      // The instance's disposal arrives as an ordinary frame (the disposed
      // event rides the same bus): end the body at it so the response FINs
      // cleanly instead of wedging a dead instance's stream open.
      Stream.takeUntil((frame) => frame.payload.type === "server.instance.disposed"),
    )

    // #1798 phase C: emit through the shared bounded, non-blocking write path
    // (sse-bounded-writer.ts) instead of handing the merged stream to the
    // platform writer (which parks forever on a full corpse socket). The
    // writer fiber encodes every frame and hands each chunk to a small bounded
    // queue; a stalled offer trips the bound, names the corpse in telemetry
    // (SSE-DROP) and tears its socket down — a dead subscriber wedges NOTHING.
    const scope = yield* Effect.scope
    return yield* makeBoundedSseWriter({
      serverRequest: request,
      route: EventPaths.event,
      connId,
      source: Stream.fromArray(preamble).pipe(
        Stream.concat(live.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
      ),
      eventQueueDepth: () => Queue.sizeUnsafe(queue),
      onEnded: Effect.gen(function* () {
        yield* Effect.logInfo("event disconnected")
        yield* Effect.sync(() => sseTickTelemetry.unregisterConnection(connId))
      }),
      scope,
    })
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  handlers.handleRaw(
    "subscribe",
    Effect.fn("EventHttpApi.subscribe")(function* () {
      return yield* eventResponse()
    }),
  ),
)
