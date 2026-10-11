import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "./schema"
import { RuntimeState } from "@opencode-ai/core/runtime-state"
import { Effect, Fiber, Layer, Context, Scope } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const pendingDirectory = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  return ctx ? ctx.directory : null
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    // ── shared-store plumbing (#1760 P2) ─────────────────────────────────────
    // A non-idle status claims the session busy in the shared store (any
    // component can see where it runs and whether the owner is alive); a
    // scoped heartbeat fiber keeps the claim fresh while it lasts.

    const heartbeats = yield* InstanceState.make(
      Effect.fn("SessionStatus.heartbeats")(function* () {
        const scope = yield* Scope.Scope
        const fibers = new Map<SessionID, Fiber.RuntimeFiber<void, unknown>>()
        // Belt to the scope's own close: any heartbeat still running when the
        // instance tears down is interrupted here as well.
        yield* Effect.addFinalizer(() =>
          Effect.forEach(fibers.values(), (fiber) => Fiber.interrupt(fiber), {
            concurrency: "unbounded",
            discard: true,
          }),
        )
        return { scope, fibers }
      }),
    )

    const heartbeat = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const runtime = RuntimeState.getGlobal()
        if (!runtime) return
        for (;;) {
          yield* Effect.sleep(RuntimeState.HEARTBEAT_INTERVAL_MS)
          const data = yield* InstanceState.get(state)
          if (!data.has(sessionID)) return
          yield* RuntimeState.bestEffort(runtime.busyHeartbeat({ sessionID }))
        }
      })

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      const runtime = RuntimeState.getGlobal()
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        // The claim is over: stop the heartbeat fiber and drop the busy row.
        const fibers = (yield* InstanceState.get(heartbeats)).fibers
        const existing = fibers.get(sessionID)
        if (existing) {
          fibers.delete(sessionID)
          yield* Fiber.interrupt(existing)
        }
        if (runtime) yield* RuntimeState.bestEffort(runtime.busyExit({ sessionID }))
        return
      }
      data.set(sessionID, status)
      if (!runtime) return
      const directory = yield* pendingDirectory
      yield* RuntimeState.bestEffort(runtime.busyEnter({ sessionID, directory }))
      const { scope, fibers } = yield* InstanceState.get(heartbeats)
      if (!fibers.has(sessionID)) {
        fibers.set(sessionID, yield* heartbeat(sessionID).pipe(Effect.forkIn(scope)))
      }
    })

    return Service.of({ get, list, set })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as SessionStatus from "./status"
