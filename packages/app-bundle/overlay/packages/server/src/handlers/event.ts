import { EventV2 } from "@opencode-ai/core/event"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Effect, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"

const subscriberCapacity = 256

// SSE reconnects are silent: EventSource retries automatically, heartbeats
// keep the stream looking alive, and every event published during the
// disconnect is lost — tabs wedge mid-turn ("thinking" with no updates)
// until a manual reload. The client already carries a cursor (#1264:
// sessionStorage `lastEventID` query param; browser EventSource does the
// same via the Last-Event-ID header once the server emits SSE ids). This
// side of the contract: tag every SSE event with its id, keep a bounded
// process-wide ring of recent wire payloads, and replay the gap on
// reconnect. When the cursor predates the ring's retention (or a fresh
// process cannot cover it at all), emit a `state.resync` sentinel so
// clients can refetch instead of silently missing events.
const RING_CAPACITY = 8192
const RING_BYTE_BUDGET = 48 * 1024 * 1024

interface RingEntry {
  readonly id: string
  readonly json: string
  readonly size: number
}

const ring: Array<RingEntry> = []
let ringBytes = 0
let ringEvictedThrough: string | undefined

const ringAppend = (event: EventV2.Payload): Effect.Effect<void> =>
  Effect.sync(() => {
    const last = ring[ring.length - 1]
    if (last !== undefined && last.id === event.id) return
    let json: string
    try {
      json = JSON.stringify(Schema.encodeUnknownSync(OpenCodeEvent)(event))
    } catch {
      // Not every bus event is in the V2 wire schema (legacy v1 events ride
      // the same bus); keep them in the ring in their raw shape so reconnect
      // replay still covers them.
      json = JSON.stringify({ id: event.id, type: event.type, data: event.data })
    }
    const size = json.length + event.id.length
    ringBytes += size
    ring.push({ id: event.id, json, size })
    while (ring.length > RING_CAPACITY || (ring.length > 0 && ringBytes > RING_BYTE_BUDGET)) {
      const evicted = ring.shift()
      if (evicted === undefined) break
      ringBytes -= evicted.size
      ringEvictedThrough = evicted.id
    }
  })

function eventData(data: unknown): Sse.Event {
  const encoded = Schema.encodeUnknownSync(OpenCodeEvent)(data) as { id?: string }
  return {
    _tag: "Event",
    event: "message",
    id: encoded.id,
    data: JSON.stringify(encoded),
  }
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

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.listen(ringAppend)
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const cursor = cursorFromRequest(yield* HttpServerRequest.HttpServerRequest)
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        const preamble = new Array<{ id: string; json: string }>()
        preamble.push({ id: connected.id, json: JSON.stringify(connected) })
        const replayedIds = new Set<string>()
        let replayWatermark: string | undefined
        if (cursor !== undefined) {
          const oldest = ring[0]
          if (
            oldest === undefined ||
            cursor < oldest.id ||
            (ringEvictedThrough !== undefined && cursor <= ringEvictedThrough)
          ) {
            const resyncID = EventV2.ID.create()
            preamble.push({
              id: resyncID,
              json: JSON.stringify({ id: resyncID, type: "state.resync", data: { reason: "retention" } }),
            })
          } else {
            for (const entry of ring) {
              if (entry.id <= cursor) continue
              replayedIds.add(entry.id)
              replayWatermark = entry.id
              preamble.push({ id: entry.id, json: entry.json })
            }
          }
        }
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* EventV2.allBounded(events, subscriberCapacity)
            return live.pipe(
              Stream.filter(
                (event) =>
                  !replayedIds.has(event.id) && (replayWatermark === undefined || event.id > replayWatermark),
              ),
            )
          }),
        ).pipe(Stream.map(eventData), Stream.pipeThroughChannel(Sse.encode()))
        const preambleStream = Stream.fromArray(preamble).pipe(
          Stream.map(
            (entry): Sse.Event => ({
              _tag: "Event",
              event: "message",
              id: entry.id,
              data: entry.json,
            }),
          ),
          Stream.pipeThroughChannel(Sse.encode()),
        )
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          preambleStream.pipe(
            Stream.concat(output),
            Stream.merge(heartbeat, { haltStrategy: "left" }),
            Stream.encodeText,
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
      }),
    )
  }),
)
