import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { GlobalEventReplay, formatID, type Frame } from "@/bus/global-replay"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
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

// A per-connection control frame (connected, heartbeat). It never consumes a
// sequence — that would punch a hole in every other subscriber's stream — and
// carries the connection's current position as its id instead.
function controlEvent(seq: number, type: string, properties: Record<string, unknown> = {}): Sse.Event {
  return frameEvent({
    id: formatID(GlobalBus.epoch, seq),
    data: JSON.stringify({ payload: { id: EventV2.ID.create(), type, properties } }),
  })
}

function eventResponse() {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const cursor = cursorOf(request)
    // Registration is eager and synchronous: a bus event emitted while the
    // response body is starting is queued, never lost.
    const queue = yield* Queue.unbounded<Sse.Event>()
    const subscription = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const subscription = GlobalEventReplay.subscribe(cursor)
        Queue.offerUnsafe(queue, controlEvent(subscription.position, "server.connected"))
        for (const frame of subscription.replay) Queue.offerUnsafe(queue, frameEvent(frame))
        subscription.start((frame) => Queue.offerUnsafe(queue, frameEvent(frame)))
        return subscription
      }),
      (subscription) => Effect.sync(() => subscription.close()),
    )
    yield* Effect.logInfo("global event connected")
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => controlEvent(GlobalBus.seq, "server.heartbeat")),
    )

    return HttpServerResponse.stream(
      Stream.fromQueue(queue).pipe(
        Stream.merge(heartbeat, { haltStrategy: "left" }),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(
          Effect.suspend(() => {
            subscription.close()
            return Effect.logInfo("global event disconnected")
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
