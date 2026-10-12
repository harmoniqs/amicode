import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { GlobalEventReplay, formatID, type Frame, type Subscription } from "@/bus/global-replay"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Clock, Deferred, Effect, Exit, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import type { Socket } from "node:net"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"

// The resume cursor: the standard `Last-Event-ID` header (what an SSE client
// sends once it has seen an `id:` line), else the `lastEventID` query
// parameter clients already send.
function cursorOf(request: HttpServerRequest.HttpServerRequest) {
  const header = request.headers["last-event-id"]?.trim()
  if (header) return header
  return new URL(request.url, "http://localhost").searchParams.get("lastEventID")?.trim() || undefined
}

function frameEvent(frame: Pick<Frame, "id" | "data">): Sse.Event {
  return { _tag: "Event", event: "message", id: frame.id, data: frame.data }
}

// A per-connection control frame (connected, heartbeat, reset). It never
// consumes a sequence — that would punch a hole in every other subscriber's
// stream — and carries the connection's current position as its id instead,
// so ids on one connection never decrease.
function controlEvent(seq: number, type: string, properties: Record<string, unknown> = {}): Sse.Event {
  return frameEvent({
    id: formatID(GlobalEventReplay.epoch, seq),
    data: JSON.stringify({ payload: { id: EventV2.ID.create(), type, properties } }),
  })
}

// The node:http adapter interrupts a request fiber only on the response's
// "close" event, which Bun's node:http shim (the engine's runtime) never emits
// when a client aborts a streaming response — it emits the request's
// "aborted"/"close" and the socket's "close", and writes to the dead socket keep
// returning true. Without this the stream, its bus subscription and its queue
// outlive the client forever. Watch the socket itself; the response owns it
// for the stream's lifetime.
function clientGone(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const gone = yield* Deferred.make<void>()
    const done = () => Deferred.doneUnsafe(gone, Exit.void)
    const socket = (request.source as { socket?: Partial<Socket> } | undefined)?.socket
    if (!socket || typeof socket.once !== "function" || typeof socket.off !== "function") return gone
    if (socket.destroyed) {
      done()
      return gone
    }
    socket.once("close", done)
    yield* Effect.addFinalizer(() => Effect.sync(() => socket.off?.("close", done)))
    return gone
  })
}

function eventResponse() {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const cursor = cursorOf(request)
    const gone = yield* clientGone(request)
    // Registration is eager and synchronous: a bus event emitted while the
    // response body is starting is queued, never lost.
    const queue = yield* Queue.unbounded<Sse.Event>()
    // Unregister the listener and drop the undelivered frames with the queue.
    // Idempotent: it runs at the stream's end and again at the request scope's.
    const release = (subscription: Subscription) =>
      Effect.andThen(Effect.sync(() => subscription.close()), Queue.shutdown(queue))
    const subscription = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const subscription = GlobalEventReplay.subscribe(cursor)
        // An unservable cursor is never silent: a reset frame comes first,
        // carrying the current epoch and sequence, and the client resyncs.
        if (subscription.reset)
          Queue.offerUnsafe(
            queue,
            controlEvent(subscription.position, "server.cursor.unservable", {
              epoch: GlobalEventReplay.epoch,
              seq: subscription.position,
            }),
          )
        Queue.offerUnsafe(queue, controlEvent(subscription.position, "server.connected"))
        for (const frame of subscription.replay) Queue.offerUnsafe(queue, frameEvent(frame))
        subscription.start((frame) => Queue.offerUnsafe(queue, frameEvent(frame)))
        return subscription
      }),
      release,
    )
    yield* Effect.logInfo("global event connected").pipe(
      Effect.annotateLogs({
        subscribers: GlobalEventReplay.subscribers,
        resume: subscription.reset ? `reset:${subscription.reset}` : cursor ? "replay" : "live",
        replayed: subscription.replay.length,
      }),
    )
    // The heartbeat enters the connection's own queue, behind every frame up to
    // the current sequence, so a backlogged connection never sees a heartbeat
    // claim a sequence it has not been sent yet (that would read as a hole).
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.mapEffect(() =>
        Effect.map(Clock.currentTimeMillis, (time) => {
          const seq = GlobalEventReplay.current
          Queue.offerUnsafe(queue, controlEvent(seq, "server.heartbeat", { time, seq }))
        }),
      ),
      Stream.drain,
    )

    return HttpServerResponse.stream(
      Stream.fromQueue(queue).pipe(
        Stream.merge(heartbeat, { haltStrategy: "left" }),
        Stream.interruptWhen(Deferred.await(gone)),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        // Release when the stream ends (client gone, or server shutdown), then
        // log the disconnect with what remains (read after the release ran).
        Stream.ensuring(
          Effect.suspend(() => {
            const dropped = Queue.sizeUnsafe(queue)
            return release(subscription).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  Effect.logInfo("global event disconnected").pipe(
                    Effect.annotateLogs({ subscribers: GlobalEventReplay.subscribers, dropped }),
                  ),
                ),
              ),
            )
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

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
