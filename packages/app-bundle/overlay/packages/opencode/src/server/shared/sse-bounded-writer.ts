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
//
// Shared by every SSE route (the instance /event route and the global
// /global/event route — #1806 P1a composes the ported global stream onto this
// same write path, so one corpse-proof discipline covers both).
import { NodeHttpServerRequest } from "@effect/platform-node"
import { Deferred, Effect, Queue, Stream } from "effect"
import type { Scope } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { sseTickTelemetry } from "./sse-tick-telemetry"

// The per-connection bounded write queue: 64 chunks of headroom before the
// offer bound trips and the subscriber is declared a corpse.
const WRITE_QUEUE_CAPACITY = 64
// The writer's end-of-stream sentinel handed through the write queue: a
// zero-length chunk is never a real SSE frame.
const END_OF_STREAM = new Uint8Array(0)

class WriteStallError {
  readonly _tag = "WriteStallError"
}

/**
 * Run an SSE source through the bounded, non-blocking write path instead of
 * handing the stream to the platform writer (which parks forever on a full
 * corpse socket — see the header). This connection's writer fiber encodes
 * every frame and hands each chunk to a small bounded queue; the response body
 * is just that queue, so backpressure from a dead socket can only ever fill
 * 64 chunks before the offer bound trips and the corpse is dropped.
 */
export function makeBoundedSseWriter(input: {
  serverRequest: HttpServerRequest.HttpServerRequest
  /** Telemetry route tag (rides the SSE-TICK/SSE-DROP lines). */
  route: string
  /** Telemetry connection identity. */
  connId: string
  /** The frames to write, already merged with the heartbeat. */
  source: Stream.Stream<Sse.Event>
  /** The connection's pre-encode event queue depth (the SSE-DROP discriminator). */
  eventQueueDepth: () => number
  /** Runs once when the response body ends (drop, client gone, or clean end). */
  onEnded: Effect.Effect<void>
  /** Optional abort source (a resolved Deferred ends the write). */
  haltWhen?: Deferred.Deferred<void, never>
  scope: Scope.Scope
}): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.gen(function* () {
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
          sseTickTelemetry.noteDrop(input.route, input.connId, {
            reason: "stalled_write",
            eventQueueDepth: input.eventQueueDepth(),
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
            const rawResponse = NodeHttpServerRequest.toServerResponse(input.serverRequest)
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
    const source =
      input.haltWhen === undefined
        ? input.source
        : input.source.pipe(Stream.interruptWhen(Deferred.await(input.haltWhen)))
    yield* source
      .pipe(
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
        Effect.forkIn(input.scope),
      )
    return HttpServerResponse.stream(
      Stream.fromQueue(writeQueue).pipe(
        Stream.takeUntil((chunk) => chunk.length === 0),
        Stream.ensuring(input.onEnded),
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

export * as SseBoundedWriter from "./sse-bounded-writer"
