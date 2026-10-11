import { afterEach, describe, expect } from "bun:test"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Queue } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeState } from "@opencode-ai/core/runtime-state"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

// The shared runtime-state store rides along on the permission layers: each
// test builds a fresh in-memory database and registers the process-global handle.
const storeLayer = Layer.provide(RuntimeState.layer, Database.layerFromPath(":memory:"))
const layers = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node])),
  testInstanceStoreLayer,
  storeLayer,
)
const lifecycle = testEffect(layers)

afterEach(async () => {
  await disposeAllInstances()
})

const askEffect = Effect.fn("PermissionStoreTest.ask")(function* (input: PermissionV1.AskInput) {
  const permission = yield* Permission.Service
  return yield* permission.ask(input)
})

const replyEffect = Effect.fn("PermissionStoreTest.reply")(function* (input: PermissionV1.ReplyInput) {
  const permission = yield* Permission.Service
  return yield* permission.reply(input)
})

/** A persistent Asked feed subscribed for the whole test. */
const askedFeed = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<PermissionV1.Request>()
  const off = yield* events.listen((event) => {
    if (event.type === Permission.Event.Asked.type) Queue.offerUnsafe(asked, event.data as PermissionV1.Request)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  return asked
})

describe("Permission shared runtime state (#1760 P2)", () => {
  lifecycle.effect(
    "a mis-routed once reply settles through the store and the owning ask resolves",
    () =>
      Effect.gen(function* () {
        const one = yield* tmpdirScoped({ git: true })
        const two = yield* tmpdirScoped({ git: true })

        const fiber = yield* askEffect({
          sessionID: SessionID.make("ses_misrouted"),
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(provideInstance(one), Effect.forkScoped)
        const asked = yield* askedFeed
        const request = yield* Queue.take(asked)

        // The reply arrives at the WRONG directory instance: memory miss, store hit.
        yield* replyEffect({ requestID: request.id, reply: "once" }).pipe(provideInstance(two))

        // The owning ask's reconcile loop applies the recorded resolution on its next tick.
        yield* TestClock.adjust(Duration.seconds(2))
        expect(yield* Fiber.join(fiber)).toBe(undefined)
      }),
  )

  lifecycle.effect("a mis-routed always reply preserves the always cascade in the owning instance", () =>
    Effect.gen(function* () {
      const one = yield* tmpdirScoped({ git: true })
      const two = yield* tmpdirScoped({ git: true })
      const sessionID = SessionID.make("ses_cascade")

      const asked = yield* askedFeed
      const fiberA = yield* askEffect({
        sessionID,
        permission: "bash",
        patterns: ["git *"],
        metadata: {},
        always: ["git *"],
        ruleset: [],
      }).pipe(provideInstance(one), Effect.forkScoped)
      const fiberB = yield* askEffect({
        sessionID,
        permission: "bash",
        patterns: ["git *"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(provideInstance(one), Effect.forkScoped)
      const requestA = yield* Queue.take(asked)
      yield* Queue.take(asked)

      yield* replyEffect({ requestID: requestA.id, reply: "always" }).pipe(provideInstance(two))
      yield* TestClock.adjust(Duration.seconds(2))
      expect(yield* Fiber.join(fiberA)).toBe(undefined)
      // The always cascade resolved the sibling pending ask in the owning instance.
      expect(yield* Fiber.join(fiberB)).toBe(undefined)

      // The always rule landed in the owning instance: a third ask never asks.
      const outcome = yield* Effect.raceFirst(
        askEffect({
          sessionID,
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(provideInstance(one)),
        Effect.map(Queue.take(asked), (request) => {
          throw new Error(`unexpected third ask: ${request.id}`)
        }),
      )
      expect(outcome).toBe(undefined)
    }),
  )

  lifecycle.effect("a mis-routed reject with feedback fails the owning ask with the correction", () =>
    Effect.gen(function* () {
      const one = yield* tmpdirScoped({ git: true })
      const two = yield* tmpdirScoped({ git: true })

      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_reject"),
        permission: "bash",
        patterns: ["*"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(provideInstance(one), Effect.forkScoped)
      const asked = yield* askedFeed
      const request = yield* Queue.take(asked)

      yield* replyEffect({ requestID: request.id, reply: "reject", message: "use npx" }).pipe(provideInstance(two))
      yield* TestClock.adjust(Duration.seconds(2))

      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("use npx")
    }),
  )

  lifecycle.effect("list shows pending permissions held by other instances and owners", () =>
    Effect.gen(function* () {
      const one = yield* tmpdirScoped({ git: true })
      const two = yield* tmpdirScoped({ git: true })

      const asked = yield* askedFeed
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_list"),
        permission: "bash",
        patterns: ["*"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(provideInstance(one), Effect.forkScoped)
      const request = yield* Queue.take(asked)

      // Same-process rows are EXCLUDED from the store merge: per-instance
      // memory is authoritative within the process, preserving the upstream
      // directory-isolation contract (the merge is cross-PROCESS visibility —
      // P2's actual contract — not cross-directory).
      const fromTwo = yield* Permission.Service.use((svc) => svc.list()).pipe(provideInstance(two))
      expect(fromTwo.map((item) => item.id)).not.toContain(request.id)

      // …but a row recorded by a different owner process entirely still merges.
      const runtime = yield* RuntimeState.Service
      yield* runtime.recordPending({
        kind: "permission",
        id: "per_foreign",
        sessionID: SessionID.make("ses_foreign"),
        data: {
          ...request,
          id: PermissionV1.ID.ascending("per_foreign"),
          sessionID: SessionID.make("ses_foreign"),
        },
        owner: { owner_id: "own_other", pid: 999 },
      })
      const merged = yield* Permission.Service.use((svc) => svc.list()).pipe(provideInstance(two))
      expect(merged.map((item) => item.id)).toEqual([PermissionV1.ID.ascending("per_foreign")])

      yield* Fiber.interrupt(fiber)
    }),
  )

  lifecycle.effect("a replayed reply against a settled row succeeds idempotently; unknown rows stay not found", () =>
    Effect.gen(function* () {
      const one = yield* tmpdirScoped({ git: true })
      const events = yield* EventV2Bridge.Service
      const repliedCount = { count: 0 }
      const off = yield* events.listen((event) => {
        if (event.type === Permission.Event.Replied.type) repliedCount.count++
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      const asked = yield* askedFeed
      const fiber = yield* askEffect({
        sessionID: SessionID.make("ses_replay"),
        permission: "bash",
        patterns: ["*"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(provideInstance(one), Effect.forkScoped)
      const request = yield* Queue.take(asked)

      yield* replyEffect({ requestID: request.id, reply: "once" }).pipe(provideInstance(one))
      // The replay must not 404 ("permission request not found") nor re-publish.
      yield* replyEffect({ requestID: request.id, reply: "once" }).pipe(provideInstance(one))

      expect(yield* Fiber.join(fiber)).toBe(undefined)
      expect(repliedCount.count).toBe(1)

      const exit = yield* replyEffect({ requestID: PermissionV1.ID.ascending("per_unknown"), reply: "once" })
        .pipe(provideInstance(one), Effect.exit)
      expect(exit._tag).toBe("Failure")
      const failure = exit._tag === "Failure" ? exit.cause : undefined
      expect(String(failure)).toContain("Permission.NotFoundError")
    }),
  )
})
