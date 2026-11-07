import { Cause, Effect, Fiber, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { RuntimeState } from "../../runtime-state"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/**
 * A drain's busy claim in the shared runtime-state store (#1760 P2): the row
 * appears with the session's directory when the drain starts, a scoped
 * heartbeat fiber keeps it live for the drain's duration, and the release
 * interrupts the fiber and drops the row. Best-effort throughout — execution
 * stays process-local and never blocks on the store.
 */
const busyClaim =
  (sessionID: SessionSchema.ID, directory: string | null) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const runtime = RuntimeState.getGlobal()
        if (!runtime) return undefined
        yield* RuntimeState.bestEffort(runtime.busyEnter({ sessionID, directory }))
        const fiber = yield* Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(RuntimeState.HEARTBEAT_INTERVAL_MS)
            yield* RuntimeState.bestEffort(runtime.busyHeartbeat({ sessionID }))
          }
        }).pipe(Effect.forkDetach)
        return { runtime, fiber, sessionID }
      }),
      () => self,
      (claim) =>
        Effect.gen(function* () {
          if (!claim) return
          yield* Fiber.interrupt(claim.fiber)
          yield* RuntimeState.bestEffort(claim.runtime.busyExit({ sessionID: claim.sessionID }))
        }),
    )

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          busyClaim(sessionID, session.location.directory),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
      compact: Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.compact(sessionID)).pipe(
          Effect.provide(locations.get(session.location)),
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
