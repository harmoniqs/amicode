import { afterEach, describe, expect } from "bun:test"
import { Duration, Effect, Fiber, Layer, Queue } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeState } from "@opencode-ai/core/runtime-state"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Question } from "../../src/question"
import { QuestionID } from "../../src/question/schema"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

// The shared runtime-state store rides along on the question layers: each test
// builds a fresh in-memory database and registers the process-global handle.
const storeLayer = Layer.provide(RuntimeState.layer, Database.layerFromPath(":memory:"))
const layers = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, CrossSpawnSpawner.node])),
  testInstanceStoreLayer,
  storeLayer,
)
const lifecycle = testEffect(layers)

const questions = [
  {
    question: "What would you like to do?",
    header: "Action",
    options: [
      { label: "Option 1", description: "First option" },
      { label: "Option 2", description: "Second option" },
    ],
  },
]

afterEach(async () => {
  await disposeAllInstances()
})

const askEffect = Effect.fn("QuestionStoreTest.ask")(function* (input: {
  sessionID: SessionID
  questions: ReadonlyArray<Question.Info>
}) {
  const question = yield* Question.Service
  return yield* question.ask(input)
})

const replyEffect = Effect.fn("QuestionStoreTest.reply")(function* (input: {
  requestID: QuestionID
  answers: ReadonlyArray<Question.Answer>
}) {
  const question = yield* Question.Service
  return yield* question.reply(input)
})

/** Waits for the ask to publish (the store row is recorded before the event fires). */
const waitForAsked = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<Question.Request>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, event.data as Question.Request)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  const request = yield* Queue.take(asked)
  return request
})

describe("Question shared runtime state (#1760 P2)", () => {
  lifecycle.effect(
    "a mis-routed reply settles through the store and the owning ask resolves",
    () =>
      Effect.gen(function* () {
        const one = yield* tmpdirScoped({ git: true })
        const two = yield* tmpdirScoped({ git: true })

        const fiber = yield* askEffect({ sessionID: SessionID.make("ses_misrouted"), questions }).pipe(
          provideInstance(one),
          Effect.forkScoped,
        )
        const request = yield* waitForAsked

        // The reply arrives at the WRONG directory instance: memory miss, store hit.
        yield* replyEffect({ requestID: request.id, answers: [["Option 1"]] }).pipe(provideInstance(two))

        // The owning ask's reconcile loop observes the recorded resolution on its next tick.
        yield* TestClock.adjust(Duration.seconds(2))
        expect(yield* Fiber.join(fiber)).toEqual([["Option 1"]])
      }),
  )

  lifecycle.effect("list shows pending questions held by other instances and owners", () =>
    Effect.gen(function* () {
      const one = yield* tmpdirScoped({ git: true })
      const two = yield* tmpdirScoped({ git: true })

      const fiber = yield* askEffect({ sessionID: SessionID.make("ses_list"), questions }).pipe(
        provideInstance(one),
        Effect.forkScoped,
      )
      const request = yield* waitForAsked

      // Same-process rows are EXCLUDED from the store merge: per-instance
      // memory is authoritative within the process, preserving the upstream
      // directory-isolation contract (the merge is cross-PROCESS visibility —
      // P2's actual contract — not cross-directory).
      const fromTwo = yield* Question.Service.use((svc) => svc.list()).pipe(provideInstance(two))
      expect(fromTwo.map((item) => item.id)).not.toContain(request.id)

      // …but a row recorded by a different owner process entirely still merges.
      const runtime = yield* RuntimeState.Service
      yield* runtime.recordPending({
        kind: "question",
        id: "que_foreign",
        sessionID: SessionID.make("ses_foreign"),
        data: { ...request, id: QuestionID.make("que_foreign"), sessionID: SessionID.make("ses_foreign") },
        owner: { owner_id: "own_other", pid: 999 },
      })
      const merged = yield* Question.Service.use((svc) => svc.list()).pipe(provideInstance(two))
      expect(merged.map((item) => item.id)).toEqual([QuestionID.make("que_foreign")])

      yield* Fiber.interrupt(fiber)
    }),
  )

  lifecycle.effect("a replayed reply against a settled row succeeds idempotently without a second event", () =>
    Effect.gen(function* () {
      const one = yield* tmpdirScoped({ git: true })
      const events = yield* EventV2Bridge.Service
      const repliedCount = { count: 0 }
      const off = yield* events.listen((event) => {
        if (event.type === Question.Event.Replied.type) repliedCount.count++
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      const fiber = yield* askEffect({ sessionID: SessionID.make("ses_replay"), questions }).pipe(
        provideInstance(one),
        Effect.forkScoped,
      )
      const request = yield* waitForAsked

      yield* replyEffect({ requestID: request.id, answers: [["Option 1"]] }).pipe(provideInstance(one))
      // The replay must not 404 ("question request not found") nor re-publish.
      yield* replyEffect({ requestID: request.id, answers: [["Option 1"]] }).pipe(provideInstance(one))

      expect(yield* Fiber.join(fiber)).toEqual([["Option 1"]])
      expect(repliedCount.count).toBe(1)
    }),
  )

  lifecycle.effect("replies for requests the store does not hold still fail as not found", () =>
    Effect.gen(function* () {
      const one = yield* tmpdirScoped({ git: true })
      const exit = yield* replyEffect({ requestID: QuestionID.make("que_unknown"), answers: [] })
        .pipe(provideInstance(one), Effect.exit)
      expect(exit._tag).toBe("Failure")
      const failure = exit._tag === "Failure" ? exit.cause : undefined
      expect(String(failure)).toContain("Question.NotFoundError")
    }),
  )
})
